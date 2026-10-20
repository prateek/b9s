package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/mail"
	"regexp"
	"strconv"
	"strings"
	"time"

	ops "github.com/steveyegge/beads/internal/storage/issueops"
	"github.com/steveyegge/beads/internal/timeparsing"
	"github.com/steveyegge/beads/internal/types"
	publicops "github.com/steveyegge/beads/issueops"
)

type browserWrite struct {
	Op       string            `json:"op"`
	Key      string            `json:"key"`
	Actor    string            `json:"actor"`
	Email    string            `json:"email"`
	IDs      []string          `json:"ids,omitempty"`
	Expected map[string]string `json:"expected,omitempty"`
	Fields   map[string]string `json:"fields,omitempty"`
	Status   string            `json:"status,omitempty"`
	Text     string            `json:"text,omitempty"`
	Reason   string            `json:"reason,omitempty"`
	Until    string            `json:"until,omitempty"`
}

type writeOutcome struct {
	OK      bool     `json:"ok"`
	IDs     []string `json:"ids"`
	Created string   `json:"created"`
}

type writeReceipt struct {
	Digest string       `json:"digest"`
	Result writeOutcome `json:"result"`
}

var requestKey = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)

func commandDigest(command *browserWrite) (string, error) {
	if command == nil || !requestKey.MatchString(command.Key) {
		return "", fmt.Errorf("invalid request key")
	}
	data, err := json.Marshal(command)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", sha256.Sum256(data)), nil
}

func nativeReceipt(ctx context.Context, db *sql.DB, command *browserWrite) (any, error) {
	digest, err := commandDigest(command)
	if err != nil {
		return nil, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	value, err := ops.GetMetadataInTx(ctx, tx, "b9s.request."+command.Key)
	if err != nil {
		return nil, err
	}
	var receipt writeReceipt
	if value != "" {
		if err := json.Unmarshal([]byte(value), &receipt); err != nil {
			return nil, err
		}
		if receipt.Digest != digest {
			return nil, fmt.Errorf("request key was already used with a different command")
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if value == "" {
		return map[string]any{"state": "absent"}, nil
	}
	return map[string]any{"state": "recorded", "result": receipt.Result}, nil
}

func field[T any](value T) publicops.Field[T] {
	return publicops.Field[T]{Set: true, Value: value}
}

func issuePatch(fields map[string]string, creating bool) (publicops.IssuePatch, error) {
	var patch publicops.IssuePatch
	for key, value := range fields {
		switch key {
		case "title":
			patch.Title = field(value)
		case "description":
			patch.Description = field(value)
		case "design":
			patch.Design = field(value)
		case "acceptance":
			patch.AcceptanceCriteria = field(value)
		case "notes":
			patch.Notes = field(value)
		case "priority":
			priority, err := strconv.Atoi(value)
			if err != nil {
				return patch, fmt.Errorf("invalid priority %q", value)
			}
			patch.Priority = field(priority)
		case "type":
			patch.IssueType = field(types.IssueType(value))
		case "assignee":
			patch.Assignee = field(value)
		case "parent":
			patch.ParentID = field(value)
		case "status":
			if creating {
				return patch, fmt.Errorf("create does not accept status")
			}
			patch.Status = field(types.Status(value))
		case "labels":
			if !creating {
				return patch, fmt.Errorf("update requires add-label or remove-label")
			}
			patch.Labels.Replace = field(strings.Split(value, ","))
		case "add-label", "remove-label":
			if creating {
				return patch, fmt.Errorf("create requires labels")
			}
			if key == "add-label" {
				patch.Labels.Add = strings.Split(value, ",")
			} else {
				patch.Labels.Remove = strings.Split(value, ",")
			}
		default:
			return patch, fmt.Errorf("unsupported field %q", key)
		}
	}
	return patch, nil
}

func applyNativeWrite(ctx context.Context, tx *sql.Tx, command *browserWrite) (writeOutcome, error) {
	result := writeOutcome{OK: true, IDs: command.IDs}
	if command.Op == "create" {
		if len(command.IDs) != 0 {
			return result, fmt.Errorf("create takes no issue IDs")
		}
		patch, err := issuePatch(command.Fields, true)
		if err != nil {
			return result, err
		}
		issue := &types.Issue{
			Title: patch.Title.Value, Description: patch.Description.Value,
			Design: patch.Design.Value, AcceptanceCriteria: patch.AcceptanceCriteria.Value,
			Notes: patch.Notes.Value, Priority: 2, IssueType: types.IssueType("task"),
			Status: types.Status("open"), Assignee: patch.Assignee.Value,
			CreatedBy: command.Actor, Labels: patch.Labels.Replace.Value,
		}
		if patch.Priority.Set {
			issue.Priority = patch.Priority.Value
		}
		if patch.IssueType.Set {
			issue.IssueType = patch.IssueType.Value
		}
		created, _, err := ops.ExecuteCreate(ctx, tx, publicops.CreateRequest{
			Actor: command.Actor, Issue: issue, ParentID: patch.ParentID.Value,
		})
		if err != nil {
			return result, err
		}
		result.Created = created.Issue.ID
		result.IDs = []string{created.Issue.ID}
		return result, nil
	}
	if len(command.IDs) == 0 {
		return result, fmt.Errorf("no issue IDs supplied")
	}
	if (command.Op == "update" || command.Op == "comment" || command.Op == "defer") && len(command.IDs) != 1 {
		return result, fmt.Errorf("%s requires exactly one issue", command.Op)
	}
	if command.Op == "delete" {
		_, err := ops.DeleteInTx(ctx, tx, publicops.DeleteRequest{Actor: command.Actor, IDs: command.IDs, Force: true})
		return result, err
	}
	for _, id := range command.IDs {
		switch command.Op {
		case "comment":
			request := publicops.AddCommentRequest{IssueID: id, Author: command.Actor, Text: command.Text}
			if err := ops.ValidateAddCommentRequest(request); err != nil {
				return result, err
			}
			if _, _, err := ops.ExecuteAddComment(ctx, tx, request); err != nil {
				return result, err
			}
		case "close", "status":
			if command.Op == "close" || command.Status == "closed" {
				if command.Text != "" {
					if command.Reason != "" {
						return result, fmt.Errorf("close takes a comment or a reason, not both")
					}
					request := publicops.AddCommentRequest{IssueID: id, Author: command.Actor, Text: command.Text}
					if err := ops.ValidateAddCommentRequest(request); err != nil {
						return result, err
					}
					if _, _, err := ops.ExecuteAddComment(ctx, tx, request); err != nil {
						return result, err
					}
				}
				if _, _, err := ops.ExecuteClose(ctx, tx, publicops.CloseRequest{Actor: command.Actor, IssueID: id, Reason: command.Reason}); err != nil {
					return result, err
				}
			} else {
				if command.Status == "open" {
					if _, _, err := ops.ExecuteReopen(ctx, tx, publicops.ReopenRequest{Actor: command.Actor, IssueID: id}); err != nil {
						return result, err
					}
				}
				if _, _, err := ops.ExecuteUpdate(ctx, tx, publicops.UpdateRequest{
					Actor: command.Actor, IssueID: id, Patch: publicops.IssuePatch{Status: field(types.Status(command.Status))},
				}); err != nil {
					return result, err
				}
			}
		case "update", "defer":
			patch, err := issuePatch(command.Fields, false)
			if err != nil {
				return result, err
			}
			if command.Op == "update" && len(command.Fields) == 0 {
				return result, fmt.Errorf("nothing to update")
			}
			if command.Op == "defer" {
				patch.Status = field(types.StatusDeferred)
				if command.Until != "" {
					parsed, err := timeparsing.ParseRelativeTime(command.Until, time.Now())
					if err != nil {
						return result, err
					}
					patch.DeferUntil = field(&parsed)
				}
			}
			if _, _, err := ops.ExecuteUpdate(ctx, tx, publicops.UpdateRequest{Actor: command.Actor, IssueID: id, Patch: patch}); err != nil {
				return result, err
			}
		default:
			return result, fmt.Errorf("unsupported write operation %q", command.Op)
		}
	}
	return result, nil
}

func nativeWrite(ctx context.Context, db *sql.DB, command *browserWrite) (writeOutcome, error) {
	var empty writeOutcome
	if command == nil || !requestKey.MatchString(command.Key) || strings.TrimSpace(command.Actor) == "" {
		return empty, fmt.Errorf("write requires a request key and actor")
	}
	address, err := mail.ParseAddress(command.Email)
	if err != nil || address.Address != command.Email || strings.ContainsAny(command.Actor, "\r\n<>") {
		return empty, fmt.Errorf("write requires a valid commit identity")
	}
	digest, err := commandDigest(command)
	if err != nil {
		return empty, err
	}
	receiptKey := "b9s.request." + command.Key
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback()
	stored, err := ops.GetMetadataInTx(ctx, tx, receiptKey)
	if err != nil {
		return empty, err
	}
	var receipt writeReceipt
	if stored != "" {
		if err := json.Unmarshal([]byte(stored), &receipt); err != nil {
			return empty, fmt.Errorf("invalid existing request receipt: %w", err)
		}
		if receipt.Digest != digest {
			return empty, fmt.Errorf("request key was already used with a different command")
		}
	} else {
		dependencies, err := ops.GetAllDependencyRecordsInTx(ctx, tx)
		if err != nil {
			return empty, err
		}
		seen := map[string]bool{}
		for _, id := range command.IDs {
			if seen[id] {
				return empty, fmt.Errorf("duplicate issue ID %q", id)
			}
			seen[id] = true
			issue, err := ops.GetIssueInTx(ctx, tx, id)
			if err != nil {
				return empty, err
			}
			document, err := issueDocument(ctx, tx, issue, dependencies[id])
			if err != nil {
				return empty, err
			}
			if command.Expected[id] == "" || command.Expected[id] != document["revision"] {
				return empty, fmt.Errorf("stale issue %s: refresh before editing", id)
			}
		}
		result, err := applyNativeWrite(ctx, tx, command)
		if err != nil {
			return empty, err
		}
		receipt = writeReceipt{Digest: digest, Result: result}
		encoded, err := json.Marshal(receipt)
		if err != nil {
			return empty, err
		}
		if err := ops.SetMetadataInTx(ctx, tx, receiptKey, string(encoded)); err != nil {
			return empty, err
		}
		stored = string(encoded)
	}
	if err := tx.Commit(); err != nil {
		return empty, err
	}
	// The SQL transaction can survive a crash before its Dolt commit. A retry
	// finishes that commit without executing the issue operation again.
	var committed string
	err = db.QueryRowContext(ctx, "SELECT value FROM metadata AS OF 'HEAD' WHERE `key` = ?", receiptKey).Scan(&committed)
	if err != nil && err != sql.ErrNoRows {
		return empty, err
	}
	if committed != "" && committed != stored {
		return empty, fmt.Errorf("request receipt conflicts with committed history")
	}
	if committed == "" {
		if _, err := db.ExecContext(ctx, "CALL DOLT_COMMIT('-am', ?, '--author', ?)",
			"b9s: "+command.Op+" ["+command.Key+"]", command.Actor+" <"+command.Email+">"); err != nil {
			return empty, fmt.Errorf("edit is recorded locally but its Dolt commit needs retry: %w", err)
		}
	}
	return receipt.Result, nil
}
