package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/url"
	"syscall/js"

	"github.com/dolthub/dolt/go/libraries/doltcore/branch_control"
	"github.com/dolthub/dolt/go/libraries/doltcore/dbfactory"
	"github.com/dolthub/dolt/go/libraries/doltcore/doltdb"
	"github.com/dolthub/dolt/go/libraries/doltcore/doltdb/gcctx"
	"github.com/dolthub/dolt/go/libraries/doltcore/env"
	"github.com/dolthub/dolt/go/libraries/doltcore/ref"
	"github.com/dolthub/dolt/go/libraries/doltcore/sqle"
	"github.com/dolthub/dolt/go/libraries/doltcore/sqle/dsess"
	"github.com/dolthub/dolt/go/libraries/doltcore/sqle/writer"
	"github.com/dolthub/dolt/go/libraries/doltcore/table/editor"
	"github.com/dolthub/dolt/go/libraries/utils/config"
	"github.com/dolthub/dolt/go/libraries/utils/filesys"
	"github.com/dolthub/dolt/go/store/blobstore"
	"github.com/dolthub/dolt/go/store/datas"
	"github.com/dolthub/dolt/go/store/nbs"
	"github.com/dolthub/dolt/go/store/prolly/tree"
	"github.com/dolthub/dolt/go/store/types"
	gms "github.com/dolthub/go-mysql-server"
	"github.com/dolthub/go-mysql-server/sql"
)

type browserBlobs struct{}

func (browserBlobs) Path() string                   { return "indexeddb://native" }
func (browserBlobs) Teardown(context.Context) error { return nil }

func call(op, key string, data []byte, expected string, sources []string) (js.Value, error) {
	ch := make(chan struct{})
	var value js.Value
	var err error
	ok := js.FuncOf(func(_ js.Value, args []js.Value) any { value = args[0]; close(ch); return nil })
	fail := js.FuncOf(func(_ js.Value, args []js.Value) any {
		err = fmt.Errorf("IndexedDB: %s", js.Global().Get("String").Invoke(args[0]).String())
		close(ch)
		return nil
	})
	defer ok.Release()
	defer fail.Release()
	buffer := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(buffer, data)
	list := make([]any, len(sources))
	for i, source := range sources {
		list[i] = source
	}
	js.Global().Get("nativeStore").Call("call", op, key, buffer, expected, list).Call("then", ok, fail)
	<-ch
	return value, err
}

func (browserBlobs) Exists(_ context.Context, key string) (bool, error) {
	v, err := call("exists", key, nil, "", nil)
	if err != nil {
		return false, err
	}
	return v.Get("exists").Bool(), nil
}

func (browserBlobs) Get(ctx context.Context, key string, br blobstore.BlobRange) (io.ReadCloser, uint64, string, error) {
	v, err := call("get", key, nil, "", nil)
	if err != nil {
		return nil, 0, "", err
	}
	if v.Get("missing").Truthy() {
		return nil, 0, "", blobstore.NotFound{Key: key}
	}
	data := make([]byte, v.Get("bytes").Length())
	js.CopyBytesToGo(data, v.Get("bytes"))
	// Delegate native range semantics, including negative offsets, to Dolt.
	cache := blobstore.NewInMemoryBlobstore("read")
	if _, err = cache.Put(ctx, key, int64(len(data)), bytes.NewReader(data)); err != nil {
		return nil, 0, "", err
	}
	reader, size, _, err := cache.Get(ctx, key, br)
	return reader, size, v.Get("version").String(), err
}

func writeBlob(op, key, expected string, reader io.Reader) (string, error) {
	data, err := io.ReadAll(reader)
	if err != nil {
		return "", err
	}
	v, err := call(op, key, data, expected, nil)
	if err != nil {
		return "", err
	}
	if v.Get("conflict").Truthy() {
		return "", blobstore.CheckAndPutError{Key: key, ExpectedVersion: expected, ActualVersion: v.Get("version").String()}
	}
	return v.Get("version").String(), nil
}

func (browserBlobs) Put(_ context.Context, key string, _ int64, r io.Reader) (string, error) {
	return writeBlob("put", key, "", r)
}
func (browserBlobs) CheckAndPut(_ context.Context, expected, key string, _ int64, r io.Reader) (string, error) {
	return writeBlob("cas", key, expected, r)
}
func (browserBlobs) Concatenate(_ context.Context, key string, sources []string) (string, error) {
	v, err := call("concat", key, nil, "", sources)
	if err != nil {
		return "", err
	}
	return v.Get("version").String(), nil
}

type browserFactory struct{}

func (browserFactory) PrepareDB(context.Context, *types.NomsBinFormat, *url.URL, map[string]interface{}) error {
	return nil
}
func (browserFactory) CreateDB(ctx context.Context, format *types.NomsBinFormat, location *url.URL, _ map[string]interface{}) (datas.Database, types.ValueReadWriter, tree.NodeStore, error) {
	var blobs blobstore.Blobstore = browserBlobs{}
	if location.Host != "native" {
		if location.Host != "remote" || remoteBlobs == nil {
			return nil, nil, nil, fmt.Errorf("unknown native store %q", location.Host)
		}
		blobs = remoteBlobs
	}
	store, err := nbs.NewBSStore(ctx, format.VersionString(), blobs, 8<<20, nbs.NewUnlimitedMemQuotaProvider())
	if err != nil {
		return nil, nil, nil, err
	}
	nativeChunkStores[location.Host] = store
	values := types.NewValueStore(store)
	nodes := tree.NewNodeStore(store)
	return datas.NewTypesDatabase(values, nodes), values, nodes, nil
}

func withNativeEngine(branch string, use func(*gms.Engine, *sql.Context, *doltdb.DoltDB) (any, error)) (any, error) {
	if !ref.IsValidBranchName(branch) {
		return nil, fmt.Errorf("invalid native branch %q", branch)
	}
	ctx := context.Background()
	dbfactory.DBFactories["indexeddb"] = browserFactory{}
	db, err := doltdb.LoadDoltDB(ctx, types.Format_DOLT, "indexeddb://native", filesys.LocalFS)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	fs := filesys.NewInMemFS([]string{"/home/browser", "/workspace/.dolt/noms", "/workspace/.dolt/temptf"}, nil, "/workspace")
	repoState, err := env.CreateRepoState(fs, "refs/heads/"+branch)
	if err != nil {
		return nil, err
	}
	template := env.LoadWithoutDB(ctx, func() (string, error) { return "/home/browser", nil }, fs, "", "b9s-browser")
	if template.CfgLoadErr != nil {
		return nil, template.CfgLoadErr
	}
	configuration, ok := template.Config.GetConfig(env.GlobalConfig)
	if !ok {
		return nil, fmt.Errorf("native configuration unavailable")
	}
	if err := configuration.SetStrings(map[string]string{config.UserNameKey: "Browser", config.UserEmailKey: "browser@example.invalid"}); err != nil {
		return nil, err
	}
	dEnv := env.NewDoltEnv("browser", template.Config, repoState, db, fs)
	// Native remotes need not carry a working set for every committed branch.
	if _, err := dEnv.WorkingSet(ctx); err == doltdb.ErrWorkingSetNotFound {
		head, err := db.ResolveCommitRef(ctx, ref.NewBranchRef(branch))
		if err != nil {
			return nil, fmt.Errorf("opening branch %q: %w", branch, err)
		}
		root, err := head.GetRootValue(ctx)
		if err != nil {
			return nil, err
		}
		if err := dEnv.UpdateWorkingRoot(ctx, root); err != nil {
			return nil, fmt.Errorf("initializing branch working set: %w", err)
		}
	} else if err != nil {
		return nil, fmt.Errorf("opening branch working set: %w", err)
	}
	database, err := sqle.NewDatabase(ctx, "dolt", dEnv.DbData(ctx), editor.Options{})
	if err != nil {
		return nil, err
	}
	provider, err := sqle.NewDoltDatabaseProviderWithDatabase(branch, fs, database, fs, sql.EngineOverrides{})
	if err != nil {
		return nil, err
	}
	engine := gms.NewDefault(provider)
	defer engine.Close()
	session, err := dsess.NewDoltSession(sql.NewBaseSession(), provider, configuration, branch_control.CreateDefaultController(ctx), nil, writer.NewWriteSession, gcctx.NewGCSafepointController(), nil)
	if err != nil {
		return nil, err
	}
	session.SetCurrentDatabase("dolt")
	sqlCtx := sql.NewContext(ctx, sql.WithSession(session))
	if _, err := provider.Database(sqlCtx, database.Name()); err != nil {
		branches, branchErr := db.GetBranches(ctx)
		return nil, fmt.Errorf("opening %s with branches %v (%v): %w", database.Name(), branches, branchErr, err)
	}
	if _, _, err := session.LookupDbState(sqlCtx, database.Name()); err != nil {
		return nil, fmt.Errorf("initializing session: %w", err)
	}
	return use(engine, sqlCtx, db)
}
