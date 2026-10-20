package main

import (
	"syscall/js"

	"github.com/dolthub/dolt/go/libraries/doltcore/doltdb"
	gms "github.com/dolthub/go-mysql-server"
	"github.com/dolthub/go-mysql-server/sql"
)

func main() {
	branch := js.Global().Get("nativeBranch").String()
	_, err := withNativeEngine(branch, func(engine *gms.Engine, ctx *sql.Context, db *doltdb.DoltDB) (any, error) {
		return nil, serveNative(engine, ctx, db, branch)
	})
	if err != nil {
		js.Global().Set("nativeFailure", err.Error())
	}
}
