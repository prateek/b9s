package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/mail"
	"strings"

	"github.com/dolthub/dolt/go/store/hash"
	ops "github.com/steveyegge/beads/internal/storage/issueops"
)

type browserResolution struct {
	Key     string                 `json:"key"`
	Ours    string                 `json:"ours"`
	Theirs  string                 `json:"theirs"`
	Choices []nativeConflictChoice `json:"choices"`
}

type nativeConflictChoice struct {
	Table string `json:"table"`
	ID    string `json:"id"`
	Side  string `json:"side"`
}

func resolutionResult(command *browserResolution) any {
	return map[string]any{"ok": true, "key": command.Key}
}

func resolutionDigest(command *browserResolution, identity *browserIdentity, branch string) (string, error) {
	if command == nil || !requestKey.MatchString(command.Key) || !hash.IsValid(command.Ours) || !hash.IsValid(command.Theirs) {
		return "", fmt.Errorf("invalid resolution identity or reviewed heads")
	}
	if identity == nil || strings.TrimSpace(identity.Name) == "" || strings.ContainsAny(identity.Name, "\r\n<>") {
		return "", fmt.Errorf("a valid resolution author is required")
	}
	address, err := mail.ParseAddress(identity.Email)
	if err != nil || address.Address != identity.Email {
		return "", fmt.Errorf("a valid resolution email is required")
	}
	data, err := json.Marshal(struct {
		Command  *browserResolution
		Identity *browserIdentity
		Branch   string
	}{command, identity, branch})
	if err != nil {
		return "", err
	}
	if len(data) > 256*1024 {
		return "", fmt.Errorf("resolution is too large")
	}
	return fmt.Sprintf("%x", sha256.Sum256(data)), nil
}

func nativeResolutionRecorded(ctx context.Context, db *sql.DB, command *browserResolution, identity *browserIdentity, branch string) (bool, error) {
	digest, err := resolutionDigest(command, identity, branch)
	if err != nil {
		return false, err
	}
	var recorded string
	err = db.QueryRowContext(ctx, "SELECT value FROM metadata AS OF 'HEAD' WHERE `key` = ?", "b9s.merge."+command.Key).Scan(&recorded)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if recorded != digest {
		return false, fmt.Errorf("resolution key was used with different choices or reviewed heads")
	}
	return true, nil
}

func nativeResolutionStatus(ctx context.Context, db *sql.DB, command *browserResolution, identity *browserIdentity, branch string) (any, error) {
	if branch == "" {
		branch = "main"
	}
	recorded, err := nativeResolutionRecorded(ctx, db, command, identity, branch)
	if err != nil {
		return nil, err
	}
	if recorded {
		return map[string]any{"state": "recorded"}, nil
	}
	var dirty int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM dolt_status").Scan(&dirty); err != nil {
		return nil, err
	}
	state := "absent"
	if dirty != 0 {
		state = "unknown"
	}
	return map[string]any{"state": state}, nil
}

func nativeResolveMerge(ctx context.Context, db *sql.DB, preview *nativeMergePreviewResult, command *browserResolution, identity *browserIdentity, branch string) (any, error) {
	expected := map[string]bool{}
	for _, table := range preview.Tables {
		if table.SchemaConflicts != 0 {
			return nil, fmt.Errorf("schema conflicts require native schema resolution before synchronizing")
		}
		for _, row := range table.Rows {
			if table.Name == "metadata" {
				for _, side := range []string{"base", "our", "their"} {
					if key, ok := row[side+"_key"].(string); ok && strings.HasPrefix(strings.ToLower(key), "b9s.") {
						return nil, fmt.Errorf("conflicting operation receipts cannot be overwritten by a resolution")
					}
				}
			}
			id, ok := row["dolt_conflict_id"].(string)
			if !ok || id == "" {
				return nil, fmt.Errorf("native conflict has no stable identifier")
			}
			expected[table.Name+"\x00"+id] = true
		}
	}
	if len(expected) == 0 || len(command.Choices) != len(expected) {
		return nil, fmt.Errorf("choose a version for every conflict")
	}
	for _, choice := range command.Choices {
		key := choice.Table + "\x00" + choice.ID
		if !expected[key] || (choice.Side != "ours" && choice.Side != "theirs") {
			return nil, fmt.Errorf("invalid or duplicate conflict choice")
		}
		delete(expected, key)
	}
	digest, err := resolutionDigest(command, identity, branch)
	if err != nil {
		return nil, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var dirty int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM dolt_status").Scan(&dirty); err != nil {
		return nil, err
	}
	if dirty != 0 {
		return nil, fmt.Errorf("finish pending native changes before resolving conflicts")
	}
	var merged, message sql.NullString
	var fastForward, conflicts int64
	if err := tx.QueryRowContext(ctx, "CALL DOLT_MERGE(?, '--no-commit', '--author', ?)", command.Theirs, identity.Name+" <"+identity.Email+">").Scan(&merged, &fastForward, &conflicts, &message); err != nil {
		return nil, fmt.Errorf("starting reviewed merge: %w", err)
	}
	for _, choice := range command.Choices {
		if err := resolveNativeRow(ctx, tx, choice); err != nil {
			return nil, fmt.Errorf("resolving %s: %w", choice.Table, err)
		}
	}
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM dolt_conflicts").Scan(&dirty); err != nil {
		return nil, err
	}
	if dirty != 0 {
		return nil, fmt.Errorf("unresolved native conflicts remain")
	}
	if err := ops.RecomputeIsBlockedAfterMergeInTx(ctx, tx, command.Ours); err != nil {
		return nil, fmt.Errorf("repairing native readiness after resolution: %w", err)
	}
	if err := ops.SetMetadataInTx(ctx, tx, "b9s.merge."+command.Key, digest); err != nil {
		return nil, err
	}
	// DoltCommit atomically persists the merge parents, resolved rows and receipt.
	var commit string
	if err := tx.QueryRowContext(ctx, "CALL DOLT_COMMIT('-am', ?, '--author', ?)", "b9s: resolve ["+command.Key+"]", identity.Name+" <"+identity.Email+">").Scan(&commit); err != nil {
		return nil, fmt.Errorf("committing reviewed merge: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return resolutionResult(command), nil
}

func sqlIdentifier(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

func resolveNativeRow(ctx context.Context, tx *sql.Tx, choice nativeConflictChoice) error {
	table, conflictTable := sqlIdentifier(choice.Table), sqlIdentifier("dolt_conflicts_"+choice.Table)
	columns, err := nativeConflictRows(ctx, tx, "SHOW COLUMNS FROM "+table)
	if err != nil {
		return err
	}
	var names, selected, updates, keys []string
	prefix := "our_"
	if choice.Side == "theirs" {
		prefix = "their_"
	}
	for _, column := range columns {
		name, ok := column["Field"].(string)
		if !ok || name == "" {
			return fmt.Errorf("unsupported native conflict column")
		}
		extra := fmt.Sprint(column["Extra"])
		if strings.Contains(extra, "VIRTUAL GENERATED") || strings.Contains(extra, "STORED GENERATED") {
			continue
		}
		quoted := sqlIdentifier(name)
		names = append(names, quoted)
		selected = append(selected, "conflict."+sqlIdentifier(prefix+name))
		if column["Key"] == "PRI" {
			keys = append(keys, name)
		} else {
			updates = append(updates, "target."+quoted+"=conflict."+sqlIdentifier(prefix+name))
		}
	}
	if len(keys) == 0 {
		return fmt.Errorf("conflict resolution requires a primary key")
	}
	var count, present int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*), COUNT("+sqlIdentifier(prefix+keys[0])+") FROM "+conflictTable+" WHERE dolt_conflict_id = ?", choice.ID).Scan(&count, &present); err != nil {
		return err
	}
	if count != 1 {
		return fmt.Errorf("reviewed conflict changed")
	}
	if present == 0 {
		var predicates []string
		for _, key := range keys {
			predicates = append(predicates, "target."+sqlIdentifier(key)+" <=> COALESCE(conflict."+sqlIdentifier("our_"+key)+", conflict."+sqlIdentifier("their_"+key)+", conflict."+sqlIdentifier("base_"+key)+")")
		}
		if _, err := tx.ExecContext(ctx, "DELETE target FROM "+table+" AS target JOIN "+conflictTable+" AS conflict ON "+strings.Join(predicates, " AND ")+" WHERE conflict.dolt_conflict_id = ?", choice.ID); err != nil {
			return err
		}
	} else {
		var predicates []string
		for _, key := range keys {
			predicates = append(predicates, "target."+sqlIdentifier(key)+" <=> conflict."+sqlIdentifier(prefix+key))
		}
		join := strings.Join(predicates, " AND ")
		if len(updates) == 0 {
			updates = append(updates, "target."+sqlIdentifier(keys[0])+"=conflict."+sqlIdentifier(prefix+keys[0]))
		}
		if _, err := tx.ExecContext(ctx, "UPDATE "+table+" AS target JOIN "+conflictTable+" AS conflict ON "+join+" SET "+strings.Join(updates, ",")+" WHERE conflict.dolt_conflict_id = ?", choice.ID); err != nil {
			return err
		}
		query := "INSERT INTO " + table + " (" + strings.Join(names, ",") + ") SELECT " + strings.Join(selected, ",") + " FROM " + conflictTable + " AS conflict LEFT JOIN " + table + " AS target ON " + join + " WHERE conflict.dolt_conflict_id = ? AND target." + sqlIdentifier(keys[0]) + " IS NULL"
		if _, err := tx.ExecContext(ctx, query, choice.ID); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, "DELETE FROM "+conflictTable+" WHERE dolt_conflict_id = ?", choice.ID)
	return err
}
