package main

import (
	"bytes"
	"context"
	stdsql "database/sql"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall/js"

	"github.com/dolthub/dolt/go/libraries/doltcore/diff"
	"github.com/dolthub/dolt/go/libraries/doltcore/doltdb"
	"github.com/dolthub/dolt/go/libraries/doltcore/ref"
	"github.com/dolthub/dolt/go/libraries/utils/filesys"
	"github.com/dolthub/dolt/go/store/blobstore"
	"github.com/dolthub/dolt/go/store/chunks"
	"github.com/dolthub/dolt/go/store/hash"
	"github.com/dolthub/dolt/go/store/types"
	"github.com/google/uuid"
	ops "github.com/steveyegge/beads/internal/storage/issueops"
	"github.com/steveyegge/beads/internal/storage/schema"
)

var nativeChunkStores = map[string]chunks.ChunkStore{}
var remoteBlobs blobstore.Blobstore

func nativeMergeRemote(ctx context.Context, db *stdsql.DB, local *doltdb.DoltDB, branch string, identity *browserIdentity, previewOnly bool, resolution *browserResolution) (any, error) {
	if identity == nil || strings.TrimSpace(identity.Name) == "" || strings.TrimSpace(identity.Email) == "" {
		return nil, fmt.Errorf("a merge identity is required")
	}
	if branch == "" {
		branch = "main"
	}
	if resolution != nil {
		recorded, err := nativeResolutionRecorded(ctx, db, resolution, identity, branch)
		if err != nil {
			return nil, err
		}
		if recorded {
			return resolutionResult(resolution), nil
		}
	}
	store, err := remoteStore(ctx)
	if err != nil {
		return nil, err
	}
	remoteBlobs = store
	defer func() {
		remoteBlobs = nil
		delete(nativeChunkStores, "remote")
	}()
	remote, err := doltdb.LoadDoltDB(ctx, types.Format_DOLT, "indexeddb://remote", filesys.LocalFS)
	if err != nil {
		return nil, err
	}
	defer remote.Close()
	commit, err := remote.ResolveCommitRef(ctx, ref.NewBranchRef(branch))
	if err != nil {
		return nil, err
	}
	head, err := commit.HashOf()
	if err != nil {
		return nil, err
	}
	copied, err := copyCommittedChunks(ctx, nativeChunkStores["native"], nativeChunkStores["remote"], head)
	if err != nil {
		return nil, err
	}
	var version int
	// This engine's AS OF planner cannot bind placeholders; hash.Hash supplies only a native hash literal.
	query := "SELECT COALESCE(MAX(version), 0) FROM schema_migrations AS OF '" + head.String() + "'"
	if err := db.QueryRowContext(ctx, query).Scan(&version); err != nil {
		return nil, fmt.Errorf("reading remote database schema: %w", err)
	}
	if version != schema.LatestVersion() {
		return nil, fmt.Errorf("remote database schema %d differs from runtime %d; update the app or use a matching native bd before synchronizing", version, schema.LatestVersion())
	}
	if previewOnly || resolution != nil {
		ours, err := local.ResolveCommitRef(ctx, ref.NewBranchRef(branch))
		if err != nil {
			return nil, err
		}
		ourHead, err := ours.HashOf()
		if err != nil {
			return nil, err
		}
		if resolution != nil && (resolution.Ours != ourHead.String() || resolution.Theirs != head.String()) {
			return nil, fmt.Errorf("the reviewed heads changed; refresh the outdated conflict preview")
		}
		preview, err := nativeMergePreview(ctx, db, ourHead, head)
		if err != nil {
			return nil, err
		}
		if resolution != nil {
			return nativeResolveMerge(ctx, db, preview, resolution, identity, branch)
		}
		return preview, nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var previous string
	if err := tx.QueryRowContext(ctx, "SELECT HASHOF('HEAD')").Scan(&previous); err != nil {
		return nil, err
	}
	var dirty int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM dolt_status").Scan(&dirty); err != nil {
		return nil, err
	}
	if dirty != 0 {
		return nil, fmt.Errorf("finish pending native changes before merging")
	}
	var merged, message stdsql.NullString
	var fastForward, conflicts int64
	err = tx.QueryRowContext(ctx, "CALL DOLT_MERGE(?, '--no-commit', '--author', ?)",
		head.String(), identity.Name+" <"+identity.Email+">").Scan(&merged, &fastForward, &conflicts, &message)
	if err != nil {
		return nil, fmt.Errorf("merging native remote: %w", err)
	}
	if conflicts != 0 {
		return nil, fmt.Errorf("native merge has conflicts: %s", message.String)
	}
	if err := ops.RecomputeIsBlockedAfterMergeInTx(ctx, tx, previous); err != nil {
		return nil, fmt.Errorf("repairing native readiness after merge: %w", err)
	}
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM dolt_status").Scan(&dirty); err != nil {
		return nil, err
	}
	var merging bool
	if err := tx.QueryRowContext(ctx, "SELECT is_merging FROM dolt_merge_status").Scan(&merging); err != nil {
		return nil, err
	}
	var finalHead string
	if dirty != 0 || merging {
		if err := tx.QueryRowContext(ctx, "CALL DOLT_COMMIT('-am', ?, '--author', ?)",
			"b9s: merge native remote", identity.Name+" <"+identity.Email+">").Scan(&finalHead); err != nil {
			return nil, fmt.Errorf("committing native merge: %w", err)
		}
	} else if err := tx.QueryRowContext(ctx, "SELECT HASHOF('HEAD')").Scan(&finalHead); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if err := local.SetHeadToCommit(ctx, ref.NewRemoteRef("b9s", branch), commit); err != nil {
		return nil, err
	}
	return map[string]any{"head": finalHead, "fastForward": fastForward == 1, "copiedChunks": copied, "message": message.String}, nil
}

type nativeConflictTable struct {
	Name            string           `json:"name"`
	DataConflicts   *int64           `json:"dataConflicts"`
	SchemaConflicts int64            `json:"schemaConflicts"`
	Rows            []map[string]any `json:"rows"`
}

type nativeMergePreviewResult struct {
	Ours   string                `json:"ours"`
	Theirs string                `json:"theirs"`
	Tables []nativeConflictTable `json:"tables"`
}

func nativeMergePreview(ctx context.Context, db *stdsql.DB, ours, theirs hash.Hash) (*nativeMergePreviewResult, error) {
	revisions := "'" + ours.String() + "', '" + theirs.String() + "'"
	rows, err := db.QueryContext(ctx, "SELECT * FROM dolt_preview_merge_conflicts_summary("+revisions+")")
	if err != nil {
		return nil, fmt.Errorf("previewing native merge: %w", err)
	}
	tables := []nativeConflictTable{}
	for rows.Next() {
		var table nativeConflictTable
		if err := rows.Scan(&table.Name, &table.DataConflicts, &table.SchemaConflicts); err != nil {
			rows.Close()
			return nil, err
		}
		table.Rows = []map[string]any{}
		tables = append(tables, table)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range tables {
		table := &tables[i]
		if table.SchemaConflicts != 0 {
			continue
		}
		name := "'" + strings.ReplaceAll(strings.ReplaceAll(table.Name, "\\", "\\\\"), "'", "''") + "'"
		table.Rows, err = nativeConflictRows(ctx, db, "SELECT * FROM dolt_preview_merge_conflicts("+revisions+", "+name+")")
		if err != nil {
			return nil, fmt.Errorf("reading native conflicts for %s: %w", table.Name, err)
		}
	}
	return &nativeMergePreviewResult{Ours: ours.String(), Theirs: theirs.String(), Tables: tables}, nil
}

type nativeQueryer interface {
	QueryContext(context.Context, string, ...any) (*stdsql.Rows, error)
}

func nativeConflictRows(ctx context.Context, db nativeQueryer, query string) ([]map[string]any, error) {
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	result := []map[string]any{}
	for rows.Next() {
		values := make([]any, len(columns))
		destinations := make([]any, len(columns))
		for i := range values {
			destinations[i] = &values[i]
		}
		if err := rows.Scan(destinations...); err != nil {
			return nil, err
		}
		record := make(map[string]any, len(columns))
		for i, name := range columns {
			value := values[i]
			if bytes, ok := value.([]byte); ok {
				value = string(bytes)
			}
			if integer, ok := value.(int64); ok {
				value = strconv.FormatInt(integer, 10)
			}
			record[name] = value
		}
		result = append(result, record)
	}
	return result, rows.Err()
}

type recordingBlobs struct {
	blobstore.Blobstore
	mu   sync.Mutex
	keys map[string]bool
}

func (b *recordingBlobs) record(key string, version string, err error) (string, error) {
	if err == nil {
		b.mu.Lock()
		b.keys[key] = true
		b.mu.Unlock()
	}
	return version, err
}
func (b *recordingBlobs) Put(ctx context.Context, key string, size int64, reader io.Reader) (string, error) {
	version, err := b.Blobstore.Put(ctx, key, size, reader)
	return b.record(key, version, err)
}
func (b *recordingBlobs) CheckAndPut(ctx context.Context, expected, key string, size int64, reader io.Reader) (string, error) {
	version, err := b.Blobstore.CheckAndPut(ctx, expected, key, size, reader)
	return b.record(key, version, err)
}
func (b *recordingBlobs) Concatenate(ctx context.Context, key string, sources []string) (string, error) {
	version, err := b.Blobstore.Concatenate(ctx, key, sources)
	return b.record(key, version, err)
}

func remoteStore(ctx context.Context) (*recordingBlobs, error) {
	entries := js.Global().Get("remoteEntries")
	if !js.Global().Get("Array").Call("isArray", entries).Bool() {
		return nil, fmt.Errorf("native remote entries are missing")
	}
	store := &recordingBlobs{
		Blobstore: blobstore.NewInMemoryBlobstore("browser-remote-" + uuid.NewString()),
		keys:      map[string]bool{},
	}
	for i := 0; i < entries.Length(); i++ {
		entry := entries.Index(i)
		key := entry.Get("key").String()
		value := entry.Get("bytes")
		if key == "" || store.keys[key] || !value.InstanceOf(js.Global().Get("Uint8Array")) {
			return nil, fmt.Errorf("invalid native remote entry")
		}
		data := make([]byte, value.Length())
		js.CopyBytesToGo(data, value)
		if _, err := store.Put(ctx, key, int64(len(data)), bytes.NewReader(data)); err != nil {
			return nil, err
		}
	}
	if !store.keys["manifest"] {
		return nil, fmt.Errorf("native remote has no manifest")
	}
	return store, nil
}

func copyCommittedChunks(ctx context.Context, destination, source chunks.ChunkStore, root hash.Hash) (int, error) {
	walk := types.WalkAddrsForNBF(types.Format_DOLT, nil)
	visited := map[hash.Hash]bool{}
	copied := 0
	var copyChunk func(hash.Hash) error
	copyChunk = func(address hash.Hash) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if visited[address] {
			return nil
		}
		exists, err := destination.Has(ctx, address)
		if err != nil || exists {
			return err
		}
		chunk, err := source.Get(ctx, address)
		if err != nil {
			return err
		}
		if chunk.IsEmpty() || chunks.NewChunk(chunk.Data()).Hash() != address {
			return fmt.Errorf("missing or corrupt native chunk %s", address)
		}
		visited[address] = true
		var children []hash.Hash
		if err := walk(chunk, func(child hash.Hash, _ bool) error {
			children = append(children, child)
			return nil
		}); err != nil {
			return err
		}
		sort.Slice(children, func(i, j int) bool { return children[i].String() < children[j].String() })
		for _, child := range children {
			if err := copyChunk(child); err != nil {
				return err
			}
		}
		if err := destination.Put(ctx, chunk, func(chunk chunks.Chunk) chunks.InsertAddrsCb {
			return func(_ context.Context, addresses hash.HashSet, _ chunks.PendingRefExists) error {
				return types.InsertAddrsFromNomsValue(chunk, types.Format_DOLT, addresses)
			}
		}); err != nil {
			return err
		}
		copied++
		return nil
	}
	if err := copyChunk(root); err != nil {
		return copied, err
	}
	current, err := destination.Root(ctx)
	if err != nil {
		return copied, err
	}
	ok, err := destination.Commit(ctx, current, current)
	if err != nil {
		return copied, err
	}
	if !ok {
		return copied, fmt.Errorf("native staging store changed while copying committed chunks")
	}
	return copied, nil
}

func nativePreparePush(ctx context.Context, local *doltdb.DoltDB, branch string) (any, error) {
	if branch == "" {
		branch = "main"
	}
	store, err := remoteStore(ctx)
	if err != nil {
		return nil, err
	}
	remoteBlobs = store
	defer func() {
		remoteBlobs = nil
		delete(nativeChunkStores, "remote")
	}()
	remote, err := doltdb.LoadDoltDB(ctx, types.Format_DOLT, "indexeddb://remote", filesys.LocalFS)
	if err != nil {
		return nil, err
	}
	defer remote.Close()
	branchRef := ref.NewBranchRef(branch)
	commit, err := local.ResolveCommitRef(ctx, branchRef)
	if err != nil {
		return nil, err
	}
	head, err := commit.HashOf()
	if err != nil {
		return nil, err
	}
	sameHead := false
	if remoteCommit, err := remote.ResolveCommitRef(ctx, branchRef); err == nil {
		remoteHead, err := remoteCommit.HashOf()
		if err != nil {
			return nil, err
		}
		sameHead = remoteHead == head
	} else if err != doltdb.ErrBranchNotFound {
		return nil, err
	}
	if !sameHead {
		canAdvance, err := remote.CanFastForward(ctx, branchRef, commit)
		if err != nil {
			return nil, err
		}
		if !canAdvance {
			return nil, fmt.Errorf("native remote history diverged: fetch and merge before publishing")
		}
	}
	copied, err := copyCommittedChunks(ctx, nativeChunkStores["remote"], nativeChunkStores["native"], head)
	if err != nil {
		return nil, err
	}
	onlyIgnored := false
	if roots, err := remote.ResolveBranchRoots(ctx, branchRef); err == nil {
		onlyIgnored, err = diff.WorkingSetContainsOnlyIgnoredTables(ctx, roots)
		if err != nil {
			return nil, err
		}
	}
	if !sameHead {
		if err := remote.FastForwardWithWorkspaceCheck(ctx, branchRef, commit, onlyIgnored); err != nil {
			return nil, err
		}
	}
	roots, err := local.ResolveBranchRoots(ctx, branchRef)
	if err != nil {
		return nil, err
	}
	workingHash, err := roots.Working.HashOf()
	if err != nil {
		return nil, err
	}
	containsWorking, err := nativeChunkStores["remote"].Has(ctx, workingHash)
	if err != nil {
		return nil, err
	}
	store.mu.Lock()
	keys := make([]string, 0, len(store.keys))
	for key := range store.keys {
		keys = append(keys, key)
	}
	store.mu.Unlock()
	sort.Strings(keys)
	entries := js.Global().Get("Array").New()
	for _, key := range keys {
		data, _, err := blobstore.GetBytes(ctx, store, key, blobstore.AllRange)
		if err != nil {
			return nil, err
		}
		buffer := js.Global().Get("Uint8Array").New(len(data))
		js.CopyBytesToJS(buffer, data)
		entries.Call("push", map[string]any{"key": key, "bytes": buffer})
	}
	js.Global().Set("preparedEntries", entries)
	return map[string]any{"head": head.String(), "changed": !sameHead, "copiedChunks": copied, "containsLocalWorkingRoot": containsWorking}, nil
}
