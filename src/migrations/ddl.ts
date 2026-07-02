/**
 * tempest-db-js — Phase 6/9: DDL rendering.
 *
 * Renders the dialect-neutral IR + operations to concrete SQL per dialect. This
 * is the ONLY place migration SQL is produced — the same operation yields the
 * right DDL for SQLite, PostgreSQL or MySQL.
 */

import type { ColumnType, DefaultValue } from "../index.js";
import type { Dialect } from "../url.js";
import type { ColumnIR, TableIR } from "./ir.js";
import type { Operation } from "./operations.js";

/** Quote an identifier for the dialect (backticks on MySQL, double-quotes else). */
function quoteId(name: string, dialect: Dialect): string {
  return dialect === "mysql"
    ? `\`${name.replace(/`/g, "``")}\``
    : `"${name.replace(/"/g, '""')}"`;
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
  if (dialect === "mysql") {
    switch (kind) {
      case "smallint":
        return "SMALLINT";
      case "integer":
        return "INT";
      case "bigint":
        return "BIGINT";
      case "numeric":
        return meta.precision !== undefined
          ? `DECIMAL(${meta.precision}${meta.scale !== undefined ? `, ${meta.scale}` : ""})`
          : "DECIMAL";
      case "real":
        return "FLOAT";
      case "double":
        return "DOUBLE";
      case "varchar":
        return `VARCHAR(${meta.length ?? 255})`;
      case "char":
        return `CHAR(${meta.length ?? 255})`;
      case "text":
        return "TEXT";
      case "boolean":
        return "TINYINT(1)";
      case "date":
        return "DATE";
      case "time":
        return "TIME";
      case "datetime":
      case "timestamp":
        return "DATETIME";
      case "blob":
        return "BLOB";
      case "json":
        return "JSON";
      case "uuid":
        return "CHAR(36)";
      case "enum":
        return `ENUM(${(meta.values ?? []).map(quoteLiteral).join(", ")})`;
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
      // Named PG enum types are handled in renderCreateTable; fall back to TEXT.
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
        return dialect === "postgresql" ? "now()" : "CURRENT_TIMESTAMP";
      case "current_date":
        return "CURRENT_DATE";
      case "current_time":
        return "CURRENT_TIME";
      case "uuidv4":
        if (dialect === "postgresql") return "gen_random_uuid()";
        if (dialect === "mysql") return "(UUID())";
        return "(lower(hex(randomblob(16))))";
    }
  }
  const value = def.value;
  if (value === null) return "NULL";
  if (typeof value === "boolean") {
    return dialect === "postgresql" ? (value ? "TRUE" : "FALSE") : value ? "1" : "0";
  }
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return quoteLiteral(value.toISOString());
  if (typeof value === "object") return quoteLiteral(JSON.stringify(value));
  return quoteLiteral(String(value));
}

/** Render one column definition: `"name" TYPE [NOT NULL] [DEFAULT x]`. */
export function renderColumnDef(col: ColumnIR, dialect: Dialect): string {
  let sql = `${quoteId(col.name, dialect)} ${renderColumnType(col.type, dialect)}`;
  if (col.notNull) sql += " NOT NULL";
  if (col.default !== null) sql += ` DEFAULT ${renderDefault(col.default, dialect)}`;
  return sql;
}

/** The PostgreSQL named-enum type for a column (`<table>_<column>`). */
function enumTypeName(table: string, column: string): string {
  return `${table}_${column}`;
}

/** True when a column is the sole integer-family PK with no explicit default. */
function isAutoIncrementPk(table: TableIR, col: ColumnIR): boolean {
  return (
    table.primaryKey.length === 1 &&
    table.primaryKey[0] === col.name &&
    col.default === null &&
    (col.type.kind === "smallint" ||
      col.type.kind === "integer" ||
      col.type.kind === "bigint")
  );
}

/** The PostgreSQL auto-incrementing serial type for an integer-family kind. */
function postgresSerialType(kind: ColumnType["kind"]): string {
  if (kind === "bigint") return "BIGSERIAL";
  if (kind === "smallint") return "SMALLSERIAL";
  return "SERIAL";
}

/**
 * Render a CREATE TABLE (plus, on PostgreSQL, any `CREATE TYPE ... AS ENUM` for
 * enum columns, which must precede the table). Returns the statement list.
 *
 * Auto-increment for a lone integer-family primary key (SQLAlchemy semantics):
 *   - SQLite: free via `INTEGER PRIMARY KEY` (rowid alias).
 *   - PostgreSQL: `SERIAL`/`BIGSERIAL`.
 *   - MySQL: `AUTO_INCREMENT` on the column (which must also be a key).
 */
function renderCreateTable(table: TableIR, dialect: Dialect): string[] {
  const typeStmts: string[] = [];
  const cols = Object.values(table.columns).map((c) => {
    if (dialect === "postgresql" && c.type.kind === "enum") {
      const typeName = enumTypeName(table.name, c.name);
      const values = (c.type.meta.values ?? []).map(quoteLiteral).join(", ");
      typeStmts.push(`CREATE TYPE ${quoteId(typeName, dialect)} AS ENUM (${values})`);
      let def = `${quoteId(c.name, dialect)} ${quoteId(typeName, dialect)}`;
      if (c.notNull) def += " NOT NULL";
      if (c.default !== null) def += ` DEFAULT ${renderDefault(c.default, dialect)}`;
      return def;
    }
    if (dialect === "postgresql" && isAutoIncrementPk(table, c)) {
      return `${quoteId(c.name, dialect)} ${postgresSerialType(c.type.kind)}`;
    }
    if (dialect === "mysql" && isAutoIncrementPk(table, c)) {
      return `${quoteId(c.name, dialect)} ${renderColumnType(c.type, dialect)} NOT NULL AUTO_INCREMENT`;
    }
    return renderColumnDef(c, dialect);
  });
  if (table.primaryKey.length > 0) {
    cols.push(
      `PRIMARY KEY (${table.primaryKey.map((c) => quoteId(c, dialect)).join(", ")})`,
    );
  }
  return [
    ...typeStmts,
    `CREATE TABLE ${quoteId(table.name, dialect)} (\n  ${cols.join(",\n  ")}\n)`,
  ];
}

/**
 * Render an operation to one or more SQL statements for the dialect.
 *
 * @param op The operation.
 * @param dialect The target dialect.
 * @returns The SQL statements (usually one).
 * @throws Error When the operation is unsupported on the dialect (e.g. SQLite
 *   `alter_column`, which needs the table-rebuild path).
 */
export function renderOperation(op: Operation, dialect: Dialect): string[] {
  switch (op.kind) {
    case "create_table":
      return renderCreateTable(op.table, dialect);
    case "drop_table":
      return [`DROP TABLE ${quoteId(op.table.name, dialect)}`];
    case "rename_table":
      return dialect === "mysql"
        ? [`RENAME TABLE ${quoteId(op.from, dialect)} TO ${quoteId(op.to, dialect)}`]
        : [
            `ALTER TABLE ${quoteId(op.from, dialect)} RENAME TO ${quoteId(op.to, dialect)}`,
          ];
    case "add_column":
      return [
        `ALTER TABLE ${quoteId(op.table, dialect)} ADD COLUMN ${renderColumnDef(op.column, dialect)}`,
      ];
    case "drop_column":
      return [
        `ALTER TABLE ${quoteId(op.table, dialect)} DROP COLUMN ${quoteId(op.column.name, dialect)}`,
      ];
    case "rename_column":
      return [
        `ALTER TABLE ${quoteId(op.table, dialect)} RENAME COLUMN ${quoteId(op.from, dialect)} TO ${quoteId(op.to, dialect)}`,
      ];
    case "alter_column":
      return renderAlterColumn(op.table, op.to, dialect);
    case "recreate_table":
      return dialect === "sqlite"
        ? renderSqliteRebuild(op.from, op.to)
        : renderTableDiff(op.from, op.to, dialect);
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
    cols.push(
      `PRIMARY KEY (${to.primaryKey.map((c) => quoteId(c, "sqlite")).join(", ")})`,
    );
  }
  const commonSql = common.map((c) => quoteId(c, "sqlite")).join(", ");
  return [
    "PRAGMA foreign_keys=off",
    `CREATE TABLE ${quoteId(tmp, "sqlite")} (\n  ${cols.join(",\n  ")}\n)`,
    common.length > 0
      ? `INSERT INTO ${quoteId(tmp, "sqlite")} (${commonSql}) SELECT ${commonSql} FROM ${quoteId(from.name, "sqlite")}`
      : `-- no common columns to copy from ${from.name}`,
    `DROP TABLE ${quoteId(from.name, "sqlite")}`,
    `ALTER TABLE ${quoteId(tmp, "sqlite")} RENAME TO ${quoteId(to.name, "sqlite")}`,
    "PRAGMA foreign_keys=on",
  ];
}

/** PostgreSQL/MySQL realize a table recreate as per-column ADD/DROP/ALTER. */
function renderTableDiff(from: TableIR, to: TableIR, dialect: Dialect): string[] {
  const stmts: string[] = [];
  for (const [name, col] of Object.entries(to.columns)) {
    if (!(name in from.columns)) {
      stmts.push(
        `ALTER TABLE ${quoteId(to.name, dialect)} ADD COLUMN ${renderColumnDef(col, dialect)}`,
      );
    } else {
      stmts.push(...renderAlterColumn(to.name, col, dialect));
    }
  }
  for (const name of Object.keys(from.columns)) {
    if (!(name in to.columns)) {
      stmts.push(
        `ALTER TABLE ${quoteId(to.name, dialect)} DROP COLUMN ${quoteId(name, dialect)}`,
      );
    }
  }
  return stmts;
}

/**
 * Render an ALTER COLUMN. SQLite needs table-rebuild (unsupported here); MySQL
 * uses a single `MODIFY COLUMN` (type + NOT NULL + DEFAULT together); PostgreSQL
 * uses separate `ALTER COLUMN ... TYPE / SET|DROP NOT NULL / SET|DROP DEFAULT`.
 */
function renderAlterColumn(table: string, to: ColumnIR, dialect: Dialect): string[] {
  if (dialect === "sqlite") {
    throw new Error(
      `alter_column on SQLite needs a table-rebuild (recreate_table); column ${table}.${to.name}`,
    );
  }
  if (dialect === "mysql") {
    return [
      `ALTER TABLE ${quoteId(table, dialect)} MODIFY COLUMN ${renderColumnDef(to, dialect)}`,
    ];
  }
  const t = quoteId(table, dialect);
  const c = quoteId(to.name, dialect);
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
