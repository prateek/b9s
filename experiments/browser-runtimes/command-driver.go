package main

import (
	"context"
	stdsql "database/sql"
	"fmt"
	"strings"

	gms "github.com/dolthub/go-mysql-server"
	"github.com/dolthub/go-mysql-server/sql"
	ops "github.com/steveyegge/beads/internal/storage/issueops"
	"github.com/steveyegge/beads/internal/storage/schema"
)

func nativeCommands(engine *gms.Engine, sqlCtx *sql.Context) error {
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
		return fmt.Errorf("native fixture schema %d differs from runtime %d", version, schema.LatestVersion())
	}
	if _, err = schema.MigrateUp(ctx, db); err != nil {
		return fmt.Errorf("initializing native workspace tables: %w", err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	_, blocked := ops.CloseIssueCheckedInTx(ctx, tx, "browser-b", "should fail", "browser", "", false, nil)
	if err = tx.Rollback(); err != nil {
		return err
	}
	if blocked == nil || !strings.Contains(blocked.Error(), "blocked") {
		return fmt.Errorf("expected native blocked-close refusal, got %v", blocked)
	}
	tx, err = db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = ops.UpdateIssueInTx(ctx, tx, "browser-b", map[string]interface{}{"title": "Browser persisted edit"}, "browser"); err != nil {
		return err
	}
	if _, err = ops.AddIssueCommentInTx(ctx, tx, "browser-b", "browser", "Written through native Beads in WASM"); err != nil {
		return err
	}
	if err := ops.SetLocalMetadataInTx(ctx, tx, "b9s.test.local_only", "Synthetic workspace-only marker"); err != nil {
		return err
	}
	return tx.Commit()
}
