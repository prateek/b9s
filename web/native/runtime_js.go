package main

import (
	"context"
	"crypto/sha256"
	stdsql "database/sql"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall/js"

	"github.com/dolthub/dolt/go/libraries/doltcore/doltdb"
	gms "github.com/dolthub/go-mysql-server"
	"github.com/dolthub/go-mysql-server/sql"
	ops "github.com/steveyegge/beads/internal/storage/issueops"
	"github.com/steveyegge/beads/internal/storage/schema"
	"github.com/steveyegge/beads/internal/types"
)

type nativeConnector struct{ *nativeDriver }

func (c nativeConnector) Connect(context.Context) (driver.Conn, error) { return c.Open("") }
func (c nativeConnector) Driver() driver.Driver                        { return c.nativeDriver }

type browserRequest struct {
	Op         string             `json:"op"`
	ID         string             `json:"id,omitempty"`
	Command    *browserWrite      `json:"command,omitempty"`
	Branch     string             `json:"branch,omitempty"`
	Identity   *browserIdentity   `json:"identity,omitempty"`
	Resolution *browserResolution `json:"resolution,omitempty"`
}

type browserIdentity struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

func issueDocument(ctx context.Context, tx *stdsql.Tx, issue *types.Issue, dependencies []*types.Dependency) (map[string]any, error) {
	comments, err := ops.GetIssueCommentsInTx(ctx, tx, issue.ID)
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(issue)
	if err != nil {
		return nil, err
	}
	var entry map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	if err := decoder.Decode(&entry); err != nil {
		return nil, err
	}
	sort.Slice(dependencies, func(i, j int) bool { return dependencies[i].DependsOnID < dependencies[j].DependsOnID })
	entry["comments"] = comments
	entry["dependencies"] = dependencies
	entry["native_revision"] = strconv.FormatInt(issue.RowVersion, 10)
	data, err = json.Marshal(entry)
	if err != nil {
		return nil, err
	}
	entry["revision"] = fmt.Sprintf("%x", sha256.Sum256(data))
	return entry, nil
}

func nativeRead(ctx context.Context, db *stdsql.DB, request browserRequest) (any, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var issues []*types.Issue
	switch request.Op {
	case "export":
		issues, err = ops.SearchIssuesInTx(ctx, tx, "", types.IssueFilter{})
	case "issue":
		var issue *types.Issue
		issue, err = ops.GetIssueInTx(ctx, tx, request.ID)
		if err == nil {
			issues = []*types.Issue{issue}
		}
	default:
		return nil, fmt.Errorf("unsupported native operation %q", request.Op)
	}
	if err != nil {
		return nil, err
	}
	dependencies, err := ops.GetAllDependencyRecordsInTx(ctx, tx)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0, len(issues))
	for _, issue := range issues {
		entry, err := issueDocument(ctx, tx, issue, dependencies[issue.ID])
		if err != nil {
			return nil, err
		}
		result = append(result, entry)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

func serveNative(engine *gms.Engine, sqlCtx *sql.Context, local *doltdb.DoltDB, branch string) error {
	db := stdsql.OpenDB(nativeConnector{&nativeDriver{engine, sqlCtx}})
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx := context.Background()
	if err := schema.CheckForwardDrift(ctx, db); err != nil {
		return err
	}
	version, err := schema.CurrentVersion(ctx, db)
	if err != nil {
		return err
	}
	if version != schema.LatestVersion() {
		return fmt.Errorf("database schema %d differs from runtime %d", version, schema.LatestVersion())
	}
	if _, err := schema.MigrateUp(ctx, db); err != nil {
		return fmt.Errorf("initializing workspace tables: %w", err)
	}
	var mu sync.Mutex
	call := js.FuncOf(func(_ js.Value, args []js.Value) any {
		payload := args[0].String()
		executor := js.FuncOf(func(_ js.Value, callbacks []js.Value) any {
			resolve, reject := callbacks[0], callbacks[1]
			go func() {
				mu.Lock()
				defer mu.Unlock()
				var request browserRequest
				decoder := json.NewDecoder(strings.NewReader(payload))
				decoder.DisallowUnknownFields()
				if err := decoder.Decode(&request); err != nil {
					reject.Invoke(js.Global().Get("Error").New(err.Error()))
					return
				}
				if request.Branch != "" && request.Branch != branch {
					reject.Invoke(js.Global().Get("Error").New(fmt.Sprintf("request branch %q differs from configured branch %q", request.Branch, branch)))
					return
				}
				request.Branch = branch
				if request.Resolution != nil && request.Op != "resolve-merge" && request.Op != "resolution-receipt" {
					reject.Invoke(js.Global().Get("Error").New("resolution choices require resolve-merge"))
					return
				}
				if err := local.Rebase(ctx); err != nil {
					reject.Invoke(js.Global().Get("Error").New(err.Error()))
					return
				}
				var value any
				var err error
				if request.Op == "write" {
					value, err = nativeWrite(ctx, db, request.Command)
				} else if request.Op == "resolution-receipt" {
					value, err = nativeResolutionStatus(ctx, db, request.Resolution, request.Identity, request.Branch)
				} else if request.Op == "receipt" {
					value, err = nativeReceipt(ctx, db, request.Command)
				} else if request.Op == "prepare-push" {
					value, err = nativePreparePush(ctx, local, request.Branch)
				} else if request.Op == "merge-remote" || request.Op == "preview-merge" || request.Op == "resolve-merge" {
					if request.Op == "resolve-merge" && request.Resolution == nil {
						err = fmt.Errorf("a reviewed resolution is required")
					} else {
						value, err = nativeMergeRemote(ctx, db, local, request.Branch, request.Identity, request.Op == "preview-merge", request.Resolution)
					}
				} else {
					value, err = nativeRead(ctx, db, request)
				}
				if err != nil {
					reject.Invoke(js.Global().Get("Error").New(err.Error()))
					return
				}
				data, err := json.Marshal(value)
				if err != nil {
					reject.Invoke(js.Global().Get("Error").New(err.Error()))
					return
				}
				resolve.Invoke(string(data))
			}()
			return nil
		})
		promise := js.Global().Get("Promise").New(executor)
		executor.Release()
		return promise
	})
	defer call.Release()
	js.Global().Set("nativeCall", call)
	select {}
}
