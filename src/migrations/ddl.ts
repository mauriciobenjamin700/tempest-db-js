/**
 * tempest-db-js — Phase 6/9: DDL rendering.
 *
 * Renders the dialect-neutral IR + operations to concrete SQL per dialect. This
 * is the ONLY place migration SQL is produced — the same operation yields the
 * right DDL for SQLite, PostgreSQL or MySQL.
 */

import type { ColumnType, DefaultValue, FkAction } from "../index.js";
import type { Dialect } from "../url.js";
import type {
  ColumnIR,
  ForeignKeyIR,
  NamedConstraint,
  TableIR,
  UniqueConstraintIR,
} from "./ir.js";
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

/** Render a referential action for an `ON DELETE` / `ON UPDATE` clause. */
function renderFkAction(action: FkAction): string {
  return action.toUpperCase();
}

/** Render the `[ON DELETE ..] [ON UPDATE ..]` tail shared by inline + table FKs. */
function renderFkActions(fk: {
  onDelete?: FkAction | undefined;
  onUpdate?: FkAction | undefined;
}): string {
  let sql = "";
  if (fk.onDelete) sql += ` ON DELETE ${renderFkAction(fk.onDelete)}`;
  if (fk.onUpdate) sql += ` ON UPDATE ${renderFkAction(fk.onUpdate)}`;
  return sql;
}

/**
 * The column-level constraint suffix: ` UNIQUE` and/or an inline
 * ` REFERENCES "table" ("column") [ON DELETE ..] [ON UPDATE ..]`. Appended to
 * every rendered column definition (including the enum/serial branches).
 */
function columnConstraintSuffix(col: ColumnIR, dialect: Dialect): string {
  let sql = "";
  if (col.unique) sql += " UNIQUE";
  if (col.references) {
    const ref = col.references;
    sql += ` REFERENCES ${quoteId(ref.table, dialect)} (${quoteId(ref.column, dialect)})`;
    sql += renderFkActions(ref);
  }
  return sql;
}

/** Render a table-level `CONSTRAINT "name" UNIQUE (...)` clause. */
function renderUniqueConstraint(uc: UniqueConstraintIR, dialect: Dialect): string {
  const cols = uc.columns.map((c) => quoteId(c, dialect)).join(", ");
  return `CONSTRAINT ${quoteId(uc.name, dialect)} UNIQUE (${cols})`;
}

/** Render a table-level `CONSTRAINT "name" FOREIGN KEY (...) REFERENCES ...` clause. */
function renderForeignKeyConstraint(fk: ForeignKeyIR, dialect: Dialect): string {
  const cols = fk.columns.map((c) => quoteId(c, dialect)).join(", ");
  const refCols = fk.refColumns.map((c) => quoteId(c, dialect)).join(", ");
  return (
    `CONSTRAINT ${quoteId(fk.name, dialect)} FOREIGN KEY (${cols}) ` +
    `REFERENCES ${quoteId(fk.refTable, dialect)} (${refCols})${renderFkActions(fk)}`
  );
}

/** The table-level constraint clauses (unique + foreign key) for a table. */
function tableConstraintClauses(table: TableIR, dialect: Dialect): string[] {
  return [
    ...table.uniqueConstraints.map((uc) => renderUniqueConstraint(uc, dialect)),
    ...table.foreignKeys.map((fk) => renderForeignKeyConstraint(fk, dialect)),
  ];
}

/**
 * Render one column definition: `"name" TYPE [NOT NULL] [DEFAULT x] [UNIQUE]
 * [REFERENCES ...]`.
 */
export function renderColumnDef(col: ColumnIR, dialect: Dialect): string {
  let sql = `${quoteId(col.name, dialect)} ${renderColumnType(col.type, dialect)}`;
  if (col.notNull) sql += " NOT NULL";
  if (col.default !== null) sql += ` DEFAULT ${renderDefault(col.default, dialect)}`;
  sql += columnConstraintSuffix(col, dialect);
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
      return def + columnConstraintSuffix(c, dialect);
    }
    if (dialect === "postgresql" && isAutoIncrementPk(table, c)) {
      return `${quoteId(c.name, dialect)} ${postgresSerialType(c.type.kind)}${columnConstraintSuffix(c, dialect)}`;
    }
    if (dialect === "mysql" && isAutoIncrementPk(table, c)) {
      return `${quoteId(c.name, dialect)} ${renderColumnType(c.type, dialect)} NOT NULL AUTO_INCREMENT${columnConstraintSuffix(c, dialect)}`;
    }
    return renderColumnDef(c, dialect);
  });
  if (table.primaryKey.length > 0) {
    cols.push(
      `PRIMARY KEY (${table.primaryKey.map((c) => quoteId(c, dialect)).join(", ")})`,
    );
  }
  cols.push(...tableConstraintClauses(table, dialect));
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
    case "add_constraint":
      return renderAddConstraint(op.table, op.constraint, dialect);
    case "drop_constraint":
      return renderDropConstraint(op.table, op.constraint, dialect);
    case "execute":
      return [op.up];
  }
}

/**
 * Render an `ALTER TABLE ... ADD CONSTRAINT`. SQLite cannot add constraints in
 * place — it needs a table-rebuild (`recreate_table`), so this throws there.
 */
function renderAddConstraint(
  table: string,
  constraint: NamedConstraint,
  dialect: Dialect,
): string[] {
  if (dialect === "sqlite") {
    throw new Error(
      `add_constraint on SQLite needs a table-rebuild (recreate_table); constraint ${constraint.constraint.name} on ${table}`,
    );
  }
  const clause =
    constraint.type === "unique"
      ? renderUniqueConstraint(constraint.constraint, dialect)
      : renderForeignKeyConstraint(constraint.constraint, dialect);
  return [`ALTER TABLE ${quoteId(table, dialect)} ADD ${clause}`];
}

/**
 * Render an `ALTER TABLE ... DROP CONSTRAINT`. PostgreSQL uses the generic
 * `DROP CONSTRAINT`; MySQL uses `DROP INDEX` (unique) / `DROP FOREIGN KEY` (fk).
 * SQLite needs a table-rebuild, so this throws there.
 */
function renderDropConstraint(
  table: string,
  constraint: NamedConstraint,
  dialect: Dialect,
): string[] {
  if (dialect === "sqlite") {
    throw new Error(
      `drop_constraint on SQLite needs a table-rebuild (recreate_table); constraint ${constraint.constraint.name} on ${table}`,
    );
  }
  const t = quoteId(table, dialect);
  const name = quoteId(constraint.constraint.name, dialect);
  if (dialect === "mysql") {
    return [
      constraint.type === "unique"
        ? `ALTER TABLE ${t} DROP INDEX ${name}`
        : `ALTER TABLE ${t} DROP FOREIGN KEY ${name}`,
    ];
  }
  return [`ALTER TABLE ${t} DROP CONSTRAINT ${name}`];
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
  cols.push(...tableConstraintClauses(to, "sqlite"));
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
