package main

import (
	"context"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	gms "github.com/dolthub/go-mysql-server"
	"github.com/dolthub/go-mysql-server/sql"
	gmstypes "github.com/dolthub/go-mysql-server/sql/types"
	"github.com/dolthub/vitess/go/sqltypes"
	"github.com/dolthub/vitess/go/vt/sqlparser"
)

type nativeDriver struct {
	engine *gms.Engine
	ctx    *sql.Context
}
type nativeConn struct{ *nativeDriver }
type nativeTx struct{ *nativeConn }
type nativeRows struct {
	ctx    *sql.Context
	schema sql.Schema
	iter   sql.RowIter
}

func (d *nativeDriver) Open(string) (driver.Conn, error) { return &nativeConn{d}, nil }
func (c *nativeConn) Close() error                       { return nil }
func (c *nativeConn) Prepare(string) (driver.Stmt, error) {
	return nil, fmt.Errorf("use parameterized context queries")
}
func (c *nativeConn) Begin() (driver.Tx, error) {
	_, err := c.ExecContext(context.Background(), "START TRANSACTION", nil)
	return &nativeTx{c}, err
}
func (t *nativeTx) Commit() error {
	_, err := t.ExecContext(context.Background(), "COMMIT", nil)
	return err
}
func (t *nativeTx) Rollback() error {
	_, err := t.ExecContext(context.Background(), "ROLLBACK", nil)
	return err
}
func (c *nativeConn) query(ctx context.Context, query string, args []driver.NamedValue) (*nativeRows, error) {
	bindings := make(map[string]sqlparser.Expr)
	for _, arg := range args {
		name := arg.Name
		if name == "" {
			name = "v" + strconv.Itoa(arg.Ordinal)
		}
		bound, err := sqltypes.BuildBindVariable(arg.Value)
		if err != nil {
			return nil, err
		}
		value, err := sqltypes.BindVariableToValue(bound)
		if err != nil {
			return nil, err
		}
		bindings[name], err = sqlparser.ExprFromValue(value)
		if err != nil {
			return nil, err
		}
	}
	queryCtx := c.ctx.WithContext(ctx)
	queryCtx.SetQueryTime(time.Now())
	schema, iter, _, err := c.engine.QueryWithBindings(queryCtx, query, nil, bindings, nil)
	if err != nil {
		return nil, err
	}
	return &nativeRows{queryCtx, schema, iter}, nil
}
func (c *nativeConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	return c.query(ctx, query, args)
}
func (c *nativeConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	pieces, err := sqlparser.SplitStatementToPieces(query)
	if err != nil {
		return nil, err
	}
	if len(pieces) > 1 && len(args) > 0 {
		return nil, fmt.Errorf("parameterized batches are unsupported")
	}
	var result driver.Result = driver.RowsAffected(0)
	for _, piece := range pieces {
		if strings.TrimSpace(piece) == "" {
			continue
		}
		result, err = c.execOne(ctx, piece, args)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}
func (c *nativeConn) execOne(ctx context.Context, query string, args []driver.NamedValue) (result driver.Result, err error) {
	rows, err := c.query(ctx, query, args)
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, rows.Close()) }()
	var affected int64
	for {
		row, err := rows.iter.Next(rows.ctx)
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if len(row) == 1 {
			if ok, isOK := row[0].(gmstypes.OkResult); isOK {
				affected += int64(ok.RowsAffected)
			}
		}
	}
	return driver.RowsAffected(affected), nil
}
func (r *nativeRows) Columns() []string {
	names := make([]string, len(r.schema))
	for i, column := range r.schema {
		names[i] = column.Name
	}
	return names
}
func (r *nativeRows) Close() error { return r.iter.Close(r.ctx) }
func (r *nativeRows) Next(dest []driver.Value) error {
	row, err := r.iter.Next(r.ctx)
	if err != nil {
		return err
	}
	for i, value := range row {
		if contextual, ok := value.(interface {
			ValueContext(context.Context) (driver.Value, error)
		}); ok {
			dest[i], err = contextual.ValueContext(r.ctx)
		} else {
			dest[i], err = driver.DefaultParameterConverter.ConvertValue(value)
		}
		if err != nil {
			return fmt.Errorf("reading %s: %w", r.schema[i].Name, err)
		}
	}
	return nil
}
