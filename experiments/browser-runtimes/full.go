package main

import (
	"context"
	"encoding/json"
	"fmt"
	"syscall/js"

	"github.com/dolthub/dolt/go/libraries/doltcore/doltdb"
	"github.com/dolthub/dolt/go/libraries/doltcore/dtestutils"
	"github.com/dolthub/dolt/go/libraries/doltcore/sqle"
	"github.com/dolthub/dolt/go/libraries/doltcore/table/editor"
	"github.com/dolthub/dolt/go/libraries/utils/filesys"
	"github.com/dolthub/dolt/go/store/types"
	"github.com/dolthub/go-mysql-server/sql"
)

func main() {
	result := map[string]any{}
	ctx := context.Background()
	db, err := doltdb.LoadDoltDB(ctx, types.Format_DOLT, doltdb.InMemDoltDB, filesys.LocalFS)
	if err == nil {
		defer db.Close()
		err = db.WriteEmptyRepo(ctx, "main", "Browser probe", "probe@example.invalid")
	}
	if err == nil {
		spec, _ := doltdb.NewCommitSpec("main")
		var optional *doltdb.OptionalCommit
		optional, err = db.Resolve(ctx, spec, nil)
		if err == nil {
			commit, ok := optional.ToCommit()
			if !ok {
				err = fmt.Errorf("commit not materialized")
			} else {
				hash, hashErr := commit.HashOf()
				err = hashErr
				result["commit"] = hash.String()
				_, err = db.ResolveHash(ctx, hash)
			}
		}
	}
	if err == nil {
		dEnv := dtestutils.CreateTestEnvWithName("browser")
		var database sqle.Database
		database, err = sqle.NewDatabase(ctx, "dolt", dEnv.DbData(ctx), editor.Options{})
		if err == nil {
			engine, sqlCtx, engineErr := sqle.NewTestEngine(dEnv, ctx, database)
			err = engineErr
			if err == nil {
				defer engine.Close()
				var results []map[string]any
				for _, query := range []string{
					"CREATE TABLE issues (id VARCHAR(64) PRIMARY KEY, title TEXT, status VARCHAR(32))",
					"INSERT INTO issues VALUES ('probe-a','Native Dolt WASM','open')",
					"CALL DOLT_ADD('-A')",
					"CALL DOLT_COMMIT('-m','initial browser data')",
					"CALL DOLT_BRANCH('mobile')",
					"CALL DOLT_CHECKOUT('mobile')",
					"UPDATE issues SET status='closed' WHERE id='probe-a'",
					"CALL DOLT_COMMIT('-am','mobile edit')",
					"CALL DOLT_CHECKOUT('main')",
					"INSERT INTO issues VALUES ('probe-b','Independent edit','open')",
					"CALL DOLT_COMMIT('-am','main edit')",
					"CALL DOLT_MERGE('mobile')",
					"SELECT id,title,status FROM issues ORDER BY id",
					"SELECT message FROM dolt_log",
				} {
					_, iter, _, queryErr := engine.Query(sqlCtx, query)
					if queryErr != nil {
						err = fmt.Errorf("%s: %w", query, queryErr)
						break
					}
					rows, rowErr := sql.RowIterToRows(sqlCtx, iter)
					if rowErr != nil {
						err = fmt.Errorf("%s: %w", query, rowErr)
						break
					}
					results = append(results, map[string]any{"sql": query, "rows": rows})
				}
				result["sql"] = results
			}
		}
	}
	if err != nil {
		result["error"] = err.Error()
	}
	out, _ := json.Marshal(result)
	js.Global().Set("doltProbeResult", string(out))
}
