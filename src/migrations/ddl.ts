/**
 * Querium — Phase 6: DDL rendering.
 *
 * Renders the dialect-neutral IR + operations to concrete SQL per dialect. This
 * is the ONLY place migration SQL is produced — the same operation yields the
 * right DDL for SQLite or PostgreSQL.
 */

import type { ColumnType, DefaultValue } from "../index.js";
import type { Dialect } from "../url.js";
import type { ColumnIR, TableIR } from "./ir.js";
import type { Operation } from "./operations.js";

function quoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Map a column type to its SQL type string for the dialect. */
export function renderColumnType(type: ColumnType, dialect: Dialect): string {
  const { kind, meta } = type;
  if (dialect === "sqlite") {
    switch (kind) {
      case "smallint":
      case "integer":
      case "bigint":
      case "boolean":
        return "INTEGER";
      case "real":
      case "double":
        return "REAL";
      case "numeric":
        return "NUMERIC";
      case "blob":
        return "BLOB";
      default:
        return "TEXT"; // varchar/char/text/uuid/enum/json/date/time/datetime/timestamp
    }
  }
  // PostgreSQL
  switch (kind) {
    case "smallint":
      return "SMALLINT";
    case "integer":
      return "INTEGER";
    case "bigint":
      return "BIGINT";
    case "numeric":
      return meta.precision !== undefined
        ? `NUMERIC(${meta.precision}${meta.scale !== undefined ? `, ${meta.scale}` : ""})`
        : "NUMERIC";
    case "real":
      return "REAL";
    case "double":
      return "DOUBLE PRECISION";
    case "varchar":
      return meta.length !== undefined ? `VARCHAR(${meta.length})` : "VARCHAR";
    case "char":
      return meta.length !== undefined ? `CHAR(${meta.length})` : "CHAR";
    case "text":
      return "TEXT";
    case "boolean":
      return "BOOLEAN";
    case "date":
      return "DATE";
    case "time":
      return meta.withTimezone ? "TIME WITH TIME ZONE" : "TIME";
    case "datetime":
    case "timestamp":
      return meta.withTimezone ? "TIMESTAMP WITH TIME ZONE" : "TIMESTAMP";
    case "blob":
      return "BYTEA";
    case "json":
      return meta.jsonb ? "JSONB" : "JSON";
    case "uuid":
      return "UUID";
    case "enum":
      // Named PG enum types are a Phase 6e refinement; fall back to TEXT for now.
      return "TEXT";
  }
}

/** Render a default value into a SQL `DEFAULT` expression for the dialect. */
export function renderDefault(def: DefaultValue, dialect: Dialect): string {
  if (def.kind === "expression") {
    const expr = def.expression;
    if (typeof expr === "object") return expr.raw;
    switch (expr) {
      case "now":
        return dialect === "sqlite" ? "CURRENT_TIMESTAMP" : "now()";
      case "current_date":
        return "CURRENT_DATE";
      case "current_time":
        return "CURRENT_TIME";
      case "uuidv4":
        return dialect === "sqlite"
          ? "(lower(hex(randomblob(16))))"
          : "gen_random_uuid()";
    }
  }
  const value = def.value;
  if (value === null) return "NULL";
  if (typeof value === "boolean") {
    return dialect === "sqlite" ? (value ? "1" : "0") : value ? "TRUE" : "FALSE";
  }
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return quoteLiteral(value.toISOString());
  if (typeof value === "object") return quoteLiteral(JSON.stringify(value));
  return quoteLiteral(String(value));
}

/** Render one column definition: `"name" TYPE [NOT NULL] [DEFAULT x]`. */
export function renderColumnDef(col: ColumnIR, dialect: Dialect): string {
  let sql = `${quoteId(col.name)} ${renderColumnType(col.type, dialect)}`;
  if (col.notNull) sql += " NOT NULL";
  if (col.default !== null) sql += ` DEFAULT ${renderDefault(col.default, dialect)}`;
  return sql;
}

/** The PostgreSQL named-enum type for a column (`<table>_<column>`). */
function enumTypeName(table: string, column: string): string {
  return `${table}_${column}`;
}

/**
 * Render a CREATE TABLE (plus, on PostgreSQL, any `CREATE TYPE ... AS ENUM` for
 * enum columns, which must precede the table). Returns the statement list.
 */
function renderCreateTable(table: TableIR, dialect: Dialect): string[] {
  const typeStmts: string[] = [];
  const cols = Object.values(table.columns).map((c) => {
    if (dialect === "postgresql" && c.type.kind === "enum") {
      const typeName = enumTypeName(table.name, c.name);
      const values = (c.type.meta.values ?? []).map(quoteLiteral).join(", ");
      typeStmts.push(`CREATE TYPE ${quoteId(typeName)} AS ENUM (${values})`);
      let def = `${quoteId(c.name)} ${quoteId(typeName)}`;
      if (c.notNull) def += " NOT NULL";
      if (c.default !== null) def += ` DEFAULT ${renderDefault(c.default, dialect)}`;
      return def;
    }
    return renderColumnDef(c, dialect);
  });
  if (table.primaryKey.length > 0) {
    cols.push(`PRIMARY KEY (${table.primaryKey.map(quoteId).join(", ")})`);
  }
  return [
    ...typeStmts,
    `CREATE TABLE ${quoteId(table.name)} (\n  ${cols.join(",\n  ")}\n)`,
  ];
}

/**
 * Render an operation to one or more SQL statements for the dialect.
 *
 * @param op The operation.
 * @param dialect The target dialect.
 * @returns The SQL statements (usually one).
 * @throws Error When the operation is unsupported on the dialect (e.g. SQLite
 *   `alter_column`, which needs the Phase 6e batch/table-rebuild path).
 */
export function renderOperation(op: Operation, dialect: Dialect): string[] {
  switch (op.kind) {
    case "create_table":
      return renderCreateTable(op.table, dialect);
    case "drop_table":
      return [`DROP TABLE ${quoteId(op.table.name)}`];
    case "rename_table":
      return [`ALTER TABLE ${quoteId(op.from)} RENAME TO ${quoteId(op.to)}`];
    case "add_column":
      return [
        `ALTER TABLE ${quoteId(op.table)} ADD COLUMN ${renderColumnDef(op.column, dialect)}`,
      ];
    case "drop_column":
      return [`ALTER TABLE ${quoteId(op.table)} DROP COLUMN ${quoteId(op.column.name)}`];
    case "rename_column":
      return [
        `ALTER TABLE ${quoteId(op.table)} RENAME COLUMN ${quoteId(op.from)} TO ${quoteId(op.to)}`,
      ];
    case "alter_column":
      return renderAlterColumn(op.table, op.to, dialect);
    case "recreate_table":
      return dialect === "sqlite"
        ? renderSqliteRebuild(op.from, op.to)
        : renderPostgresTableDiff(op.from, op.to);
    case "execute":
      return [op.up];
  }
}

/**
 * SQLite batch / table-rebuild: create a new table with the target schema, copy
 * the columns common to both, swap names. This is how SQLite realizes column
 * changes it cannot `ALTER` (drop/alter type/constraint changes).
 */
function renderSqliteRebuild(from: TableIR, to: TableIR): string[] {
  const tmp = `__new_${to.name}`;
  const common = Object.keys(to.columns).filter((c) => c in from.columns);
  const cols = Object.values(to.columns).map((c) => renderColumnDef(c, "sqlite"));
  if (to.primaryKey.length > 0) {
    cols.push(`PRIMARY KEY (${to.primaryKey.map(quoteId).join(", ")})`);
  }
  const commonSql = common.map(quoteId).join(", ");
  return [
    "PRAGMA foreign_keys=off",
    `CREATE TABLE ${quoteId(tmp)} (\n  ${cols.join(",\n  ")}\n)`,
    common.length > 0
      ? `INSERT INTO ${quoteId(tmp)} (${commonSql}) SELECT ${commonSql} FROM ${quoteId(from.name)}`
      : `-- no common columns to copy from ${from.name}`,
    `DROP TABLE ${quoteId(from.name)}`,
    `ALTER TABLE ${quoteId(tmp)} RENAME TO ${quoteId(to.name)}`,
    "PRAGMA foreign_keys=on",
  ];
}

/** PostgreSQL realizes a table recreate as per-column ADD/DROP/ALTER. */
function renderPostgresTableDiff(from: TableIR, to: TableIR): string[] {
  const stmts: string[] = [];
  for (const [name, col] of Object.entries(to.columns)) {
    if (!(name in from.columns)) {
      stmts.push(
        `ALTER TABLE ${quoteId(to.name)} ADD COLUMN ${renderColumnDef(col, "postgresql")}`,
      );
    } else {
      stmts.push(...renderAlterColumn(to.name, col, "postgresql"));
    }
  }
  for (const name of Object.keys(from.columns)) {
    if (!(name in to.columns)) {
      stmts.push(`ALTER TABLE ${quoteId(to.name)} DROP COLUMN ${quoteId(name)}`);
    }
  }
  return stmts;
}

/** Render an ALTER COLUMN (PostgreSQL); SQLite needs batch mode (Phase 6e). */
function renderAlterColumn(table: string, to: ColumnIR, dialect: Dialect): string[] {
  if (dialect === "sqlite") {
    throw new Error(
      `alter_column on SQLite needs batch/table-rebuild (Phase 6e); column ${table}.${to.name}`,
    );
  }
  const t = quoteId(table);
  const c = quoteId(to.name);
  const stmts = [
    `ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${renderColumnType(to.type, dialect)}`,
  ];
  stmts.push(
    to.notNull
      ? `ALTER TABLE ${t} ALTER COLUMN ${c} SET NOT NULL`
      : `ALTER TABLE ${t} ALTER COLUMN ${c} DROP NOT NULL`,
  );
  stmts.push(
    to.default !== null
      ? `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${renderDefault(to.default, dialect)}`
      : `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT`,
  );
  return stmts;
}
