package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"syscall/js"
	"time"

	"github.com/steveyegge/beads/internal/storage"
	ops "github.com/steveyegge/beads/internal/storage/issueops"
	"github.com/steveyegge/beads/internal/types"
)

type bridge struct{}
type connection struct{}
type transaction struct{ c *connection }
type rows struct {
	Names []string `json:"columns"`
	Data  [][]any  `json:"rows"`
	Index int
}
type result struct {
	Changes int64 `json:"changes"`
}

func (bridge) Open(string) (driver.Conn, error) { return &connection{}, nil }
func (*connection) Prepare(string) (driver.Stmt, error) {
	return nil, fmt.Errorf("prepare unsupported in probe")
}
func (*connection) Close() error { return nil }
func (c *connection) Begin() (driver.Tx, error) {
	_, err := c.ExecContext(context.Background(), "BEGIN", nil)
	return &transaction{c}, err
}
func (t *transaction) Commit() error {
	_, e := t.c.ExecContext(context.Background(), "COMMIT", nil)
	return e
}
func (t *transaction) Rollback() error {
	_, e := t.c.ExecContext(context.Background(), "ROLLBACK", nil)
	return e
}
func call(query string, args []driver.NamedValue, out any) error {
	values := make([]any, len(args))
	for i, arg := range args {
		switch v := arg.Value.(type) {
		case time.Time:
			values[i] = v.UTC().Format("2006-01-02 15:04:05.999999")
		case []byte:
			values[i] = string(v)
		case int64:
			values[i] = map[string]string{"$int64": strconv.FormatInt(v, 10)}
		default:
			values[i] = v
		}
	}
	input, _ := json.Marshal(map[string]any{"sql": query, "args": values})
	raw := js.Global().Get("probeSQL").Invoke(string(input)).String()
	var failure struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(raw), &failure); err != nil {
		return err
	}
	if failure.Error != "" {
		return fmt.Errorf("%s", failure.Error)
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	return decoder.Decode(out)
}
func (*connection) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	var r result
	err := call(query, args, &r)
	return r, err
}
func (*connection) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	var r rows
	err := call(query, args, &r)
	return &r, err
}
func (r result) LastInsertId() (int64, error) { return 0, nil }
func (r result) RowsAffected() (int64, error) { return r.Changes, nil }
func (r *rows) Columns() []string             { return r.Names }
func (r *rows) Close() error                  { return nil }
func (r *rows) Next(dest []driver.Value) error {
	if r.Index == len(r.Data) {
		return io.EOF
	}
	for i, value := range r.Data[r.Index] {
		if number, ok := value.(json.Number); ok {
			if integer, err := number.Int64(); err == nil {
				value = integer
			} else {
				value, _ = number.Float64()
			}
		}
		if tagged, ok := value.(map[string]any); ok {
			if integer, ok := tagged["$int64"].(string); ok {
				value, _ = strconv.ParseInt(integer, 10, 64)
			}
		}
		if text, ok := value.(string); ok && (strings.HasSuffix(r.Names[i], "_at") || r.Names[i] == "defer_until") {
			for _, layout := range []string{"2006-01-02 15:04:05.999999", time.RFC3339Nano} {
				if parsed, err := time.Parse(layout, text); err == nil {
					value = parsed
					break
				}
			}
		}
		dest[i] = value
	}
	r.Index++
	return nil
}

func main() {
	sql.Register("doltlite-browser", bridge{})
	db, err := sql.Open("doltlite-browser", "")
	if err != nil {
		panic(err)
	}
	db.SetMaxOpenConns(1)
	js.Global().Set("beadsProbe", js.FuncOf(func(_ js.Value, args []js.Value) any {
		var req struct{ Op, ID, Title, Target, Text, Status, Version string }
		if err := json.Unmarshal([]byte(args[0].String()), &req); err != nil {
			return encode(nil, err)
		}
		ctx := context.Background()
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return encode(nil, err)
		}
		var value any
		switch req.Op {
		case "create":
			issue := &types.Issue{ID: req.ID, Title: req.Title, Status: types.StatusOpen, Priority: 2, IssueType: types.TypeTask}
			err = ops.CreateIssueInTx(ctx, tx, &ops.BatchContext{ConfigPrefix: "probe", Opts: storage.BatchCreateOptions{CreateOnly: true}}, issue, "browser")
			value = issue
		case "get":
			value, err = ops.GetIssueInTx(ctx, tx, req.ID)
		case "update":
			value, err = ops.UpdateIssueInTx(ctx, tx, req.ID, map[string]any{"status": req.Status}, "browser")
		case "comment":
			value, err = ops.AddIssueCommentInTx(ctx, tx, req.ID, "browser", req.Text)
		case "comments":
			value, err = ops.GetIssueCommentsInTx(ctx, tx, req.ID)
		case "depend":
			value, err = ops.AddDependencyInTx(ctx, tx, &types.Dependency{IssueID: req.ID, DependsOnID: req.Target, Type: types.DepBlocks}, "browser", ops.AddDependencyOpts{})
		case "close":
			var expected *int64
			if req.Version != "" {
				var version int64
				version, err = strconv.ParseInt(req.Version, 10, 64)
				expected = &version
			}
			if err == nil {
				value, err = ops.CloseIssueCheckedInTx(ctx, tx, req.ID, "probe", "browser", "", false, expected)
			}
		case "version":
			var version int64
			err = tx.QueryRowContext(ctx, "SELECT row_lock FROM issues WHERE id = ?", req.ID).Scan(&version)
			value = strconv.FormatInt(version, 10)
		default:
			err = fmt.Errorf("unknown operation %q", req.Op)
		}
		if err != nil {
			_ = tx.Rollback()
			return encode(nil, err)
		}
		err = tx.Commit()
		return encode(value, err)
	}))
	select {}
}

func encode(value any, err error) string {
	reply := map[string]any{"value": value}
	if err != nil {
		reply["error"] = err.Error()
	}
	out, _ := json.Marshal(reply)
	return string(out)
}
