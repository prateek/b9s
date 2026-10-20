package main

import (
	"encoding/json"
	"fmt"
	"syscall/js"

	"github.com/dolthub/dolt/go/libraries/doltcore/doltdb"
	gms "github.com/dolthub/go-mysql-server"
	"github.com/dolthub/go-mysql-server/sql"
)

func runProbe(engine *gms.Engine, sqlCtx *sql.Context, db *doltdb.DoltDB) (any, error) {
	if js.Global().Get("nativeRuntime").Truthy() {
		return nil, serveNative(engine, sqlCtx, db, "main")
	}
	var results []any
	queries := []string{"SELECT id,title,status FROM issues ORDER BY id", "SELECT message FROM dolt_log LIMIT 3"}
	if js.Global().Get("persistentWrite").Truthy() {
		if err := nativeCommands(engine, sqlCtx); err != nil {
			return nil, err
		}
		queries = append([]string{"CALL DOLT_COMMIT('-am','browser durable edit')"}, queries...)
	}
	for _, query := range queries {
		_, iter, _, err := engine.Query(sqlCtx, query)
		if err != nil {
			return nil, fmt.Errorf("query %s: %w", query, err)
		}
		rows, err := sql.RowIterToRows(sqlCtx, iter)
		if err != nil {
			return nil, fmt.Errorf("reading %s: %w", query, err)
		}
		results = append(results, rows)
	}
	return results, nil
}

func main() {
	value, err := withNativeEngine("main", runProbe)
	result := map[string]any{"value": value}
	if err != nil {
		result["error"] = err.Error()
	}
	data, _ := json.Marshal(result)
	js.Global().Set("persistentResult", string(data))
}
