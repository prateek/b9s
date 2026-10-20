package main

import (
	"context"
	"encoding/json"
	"os"
	"time"

	"github.com/steveyegge/beads/internal/storage/embeddeddolt"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db, close, err := embeddeddolt.OpenSQL(ctx, os.Args[1], os.Args[2], "main")
	if err != nil {
		panic(err)
	}
	defer close()
	tables, err := db.QueryContext(ctx, "SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", os.Args[2])
	if err != nil {
		panic(err)
	}
	var names []string
	for tables.Next() {
		var name string
		if err := tables.Scan(&name); err != nil {
			panic(err)
		}
		names = append(names, name)
	}
	tables.Close()
	result := map[string]string{}
	for _, name := range names {
		var table, ddl string
		if err := db.QueryRowContext(ctx, "SHOW CREATE TABLE `"+name+"`").Scan(&table, &ddl); err != nil {
			panic(err)
		}
		result[name] = ddl
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		panic(err)
	}
}
