//go:build ignore

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/steveyegge/beads/internal/storage/embeddeddolt"
)

func main() {
	if len(os.Args) != 2 && (len(os.Args) != 3 || os.Args[2] != "inspect") {
		panic("expected disposable embedded data directory")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	db, cleanup, err := embeddeddolt.OpenSQL(ctx, os.Args[1], "browser", "main")
	if err != nil {
		panic(err)
	}
	defer cleanup()
	if len(os.Args) == 3 {
		rows, err := db.QueryContext(ctx, "SELECT id, is_blocked FROM issues AS OF 'HEAD' ORDER BY id")
		if err != nil {
			panic(err)
		}
		defer rows.Close()
		blocked := map[string]bool{}
		for rows.Next() {
			var id string
			var value bool
			if err := rows.Scan(&id, &value); err != nil {
				panic(err)
			}
			blocked[id] = value
		}
		if err := rows.Err(); err != nil {
			panic(err)
		}
		if err := json.NewEncoder(os.Stdout).Encode(blocked); err != nil {
			panic(err)
		}
		return
	}
	for _, query := range []string{
		"CALL DOLT_BRANCH('browser-review')",
		"CALL DOLT_PUSH('origin', 'browser-review')",
	} {
		rows, err := db.QueryContext(ctx, query)
		if err != nil {
			panic(err)
		}
		for rows.Next() {
		}
		if err := rows.Err(); err != nil {
			panic(err)
		}
		if err := rows.Close(); err != nil {
			panic(err)
		}
	}
	fmt.Println("Published synthetic browser-review branch")
}
