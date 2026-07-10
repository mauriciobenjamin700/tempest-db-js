/**
 * tempest-db-js — Phase 6d: SQLite introspection + drift detection.
 *
 * Reads the live schema from a SQLite database (via `PRAGMA table_info`) into a
 * `SchemaIR`, and compares it against the models to detect **drift** — the DB
 * diverging from what the migrations/models say it should be. Comparison is done
 * at SQLite's storage-affinity level, so coarse SQLite typing (every string is
 * `TEXT`) does not produce false positives.
 */

import type { AsyncDriver, SyncDriver } from "../engine.js";
import type { ColumnType } from "../index.js";
import type { ModelClass } from "../index.js";
import { renderColumnType } from "./ddl.js";
import {
  type ColumnIR,
  type ForeignKeyIR,
  type SchemaIR,
  type TableIR,
  type UniqueConstraintIR,
  reflectSchema,
} from "./ir.js";

/** SQLite's five storage classes / affinities. */
export type SqliteAffinity = "INTEGER" | "TEXT" | "REAL" | "BLOB" | "NUMERIC";

/** Apply SQLite's affinity rules to a declared type string. */
export function sqliteAffinity(declared: string): SqliteAffinity {
  const t = declared.toUpperCase();
  if (t.includes("INT")) return "INTEGER";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t.includes("BLOB") || t === "") return "BLOB";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

/** Map a SQLite affinity back to the closest IR column kind. */
function affinityToKind(affinity: SqliteAffinity): ColumnType["kind"] {
  switch (affinity) {
    case "INTEGER":
      return "integer";
    case "REAL":
      return "real";
    case "BLOB":
      return "blob";
    case "NUMERIC":
      return "numeric";
    default:
      return "text";
  }
}

interface PragmaColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface PragmaForeignKey {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
}

interface PragmaIndex {
  seq: number;
  name: string;
  unique: number;
  origin: string;
}

interface PragmaIndexColumn {
  seqno: number;
  cid: number;
  name: string;
}

/** Read a table's foreign keys via `PRAGMA foreign_key_list`, grouped by id. */
function sqliteForeignKeys(driver: SyncDriver, table: string): ForeignKeyIR[] {
  const rows = driver.execute(`PRAGMA foreign_key_list(${JSON.stringify(table)})`, [])
    .rows as unknown as PragmaForeignKey[];
  const byId = new Map<number, PragmaForeignKey[]>();
  for (const r of rows) {
    const list = byId.get(r.id) ?? [];
    list.push(r);
    byId.set(r.id, list);
  }
  const fks: ForeignKeyIR[] = [];
  for (const group of byId.values()) {
    const ordered = [...group].sort((a, b) => a.seq - b.seq);
    const columns = ordered.map((r) => r.from);
    fks.push({
      name: `fk_${table}_${columns.join("_")}`,
      columns,
      refTable: ordered[0]?.table ?? "",
      refColumns: ordered.map((r) => r.to),
    });
  }
  return fks;
}

/** Read a table's unique constraints via `PRAGMA index_list`/`index_info`. */
function sqliteUniques(driver: SyncDriver, table: string): UniqueConstraintIR[] {
  const indexes = driver.execute(`PRAGMA index_list(${JSON.stringify(table)})`, [])
    .rows as unknown as PragmaIndex[];
  const uniques: UniqueConstraintIR[] = [];
  for (const idx of indexes) {
    // origin "u" = a UNIQUE constraint; "pk" = the implicit primary-key index.
    if (Number(idx.unique) !== 1 || idx.origin === "pk") continue;
    const cols = (
      driver.execute(`PRAGMA index_info(${JSON.stringify(idx.name)})`, [])
        .rows as unknown as PragmaIndexColumn[]
    )
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name);
    if (cols.length > 0) {
      uniques.push({ name: `uq_${table}_${cols.join("_")}`, columns: cols });
    }
  }
  return uniques;
}

/**
 * Read the current SQLite schema into a `SchemaIR`. Lossy by nature (SQLite
 * collapses types into affinities), so types come back as the affinity's kind.
 *
 * @param driver A sync SQLite driver.
 * @returns The introspected schema.
 */
export function introspectSqlite(driver: SyncDriver): SchemaIR {
  const tablesRows = driver.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'tempest_db_js_migrations'",
    [],
  ).rows;

  const tables: Record<string, TableIR> = {};
  for (const row of tablesRows) {
    const tableName = String(row.name);
    const info = driver.execute(`PRAGMA table_info(${JSON.stringify(tableName)})`, [])
      .rows as unknown as PragmaColumn[];
    const columns: Record<string, ColumnIR> = {};
    const primaryKey: string[] = [];
    for (const col of info) {
      const isPk = Number(col.pk) > 0;
      const affinity = sqliteAffinity(col.type);
      columns[col.name] = {
        name: col.name,
        type: { kind: affinityToKind(affinity), meta: {} },
        notNull: Number(col.notnull) === 1 || isPk,
        primaryKey: isPk,
        default: null,
        unique: false,
        references: null,
      };
      if (isPk) primaryKey.push(col.name);
    }
    tables[tableName] = {
      name: tableName,
      columns,
      primaryKey,
      uniqueConstraints: sqliteUniques(driver, tableName),
      foreignKeys: sqliteForeignKeys(driver, tableName),
    };
  }
  return { tables };
}

/**
 * Compare the live SQLite schema against the models and report drift. Comparison
 * is at the affinity level (so `varchar` vs `TEXT` is not flagged), plus
 * nullability, primary-key, and presence of tables/columns.
 *
 * @param driver A sync SQLite driver.
 * @param models The model classes that define the intended schema.
 * @returns A list of human-readable drift messages — empty means no drift.
 */
/**
 * Normalize a table's constraints into comparable key sets, merging the
 * column-level (`.unique()` / `.references()`) and table-level (`tableArgs`)
 * forms so drift comparison is agnostic to how a constraint was declared.
 */
function constraintKeys(table: TableIR): { fks: Set<string>; uniques: Set<string> } {
  const fks = new Set<string>();
  const uniques = new Set<string>();
  for (const col of Object.values(table.columns)) {
    if (col.unique) uniques.add(col.name);
    if (col.references) {
      fks.add(`${col.name}=>${col.references.table}(${col.references.column})`);
    }
  }
  for (const uc of table.uniqueConstraints) {
    uniques.add([...uc.columns].sort().join(","));
  }
  for (const fk of table.foreignKeys) {
    fks.add(`${fk.columns.join(",")}=>${fk.refTable}(${fk.refColumns.join(",")})`);
  }
  return { fks, uniques };
}

export function checkDrift(driver: SyncDriver, models: readonly ModelClass[]): string[] {
  const actual = introspectSqlite(driver);
  const expected = reflectSchema(models);
  const issues: string[] = [];

  for (const [tableName, expectedTable] of Object.entries(expected.tables)) {
    const actualTable = actual.tables[tableName];
    if (!actualTable) {
      issues.push(`table "${tableName}" is missing from the database`);
      continue;
    }
    for (const [colName, expectedCol] of Object.entries(expectedTable.columns)) {
      const actualCol = actualTable.columns[colName];
      if (!actualCol) {
        issues.push(`column "${tableName}.${colName}" is missing from the database`);
        continue;
      }
      const expAff = sqliteAffinity(renderColumnType(expectedCol.type, "sqlite"));
      const actAff = sqliteAffinity(renderColumnType(actualCol.type, "sqlite"));
      if (expAff !== actAff) {
        issues.push(
          `column "${tableName}.${colName}" affinity differs: model ${expAff}, db ${actAff}`,
        );
      }
      if (expectedCol.notNull !== actualCol.notNull) {
        issues.push(`column "${tableName}.${colName}" nullability differs`);
      }
      if (expectedCol.primaryKey !== actualCol.primaryKey) {
        issues.push(`column "${tableName}.${colName}" primary-key flag differs`);
      }
    }
    for (const colName of Object.keys(actualTable.columns)) {
      if (!expectedTable.columns[colName]) {
        issues.push(
          `column "${tableName}.${colName}" exists in the database but not in the model`,
        );
      }
    }

    const expectedKeys = constraintKeys(expectedTable);
    const actualKeys = constraintKeys(actualTable);
    for (const fk of expectedKeys.fks) {
      if (!actualKeys.fks.has(fk)) {
        issues.push(`foreign key "${tableName}: ${fk}" is missing from the database`);
      }
    }
    for (const fk of actualKeys.fks) {
      if (!expectedKeys.fks.has(fk)) {
        issues.push(
          `foreign key "${tableName}: ${fk}" exists in the database but not in the model`,
        );
      }
    }
    for (const uq of expectedKeys.uniques) {
      if (!actualKeys.uniques.has(uq)) {
        issues.push(
          `unique constraint "${tableName}: (${uq})" is missing from the database`,
        );
      }
    }
    for (const uq of actualKeys.uniques) {
      if (!expectedKeys.uniques.has(uq)) {
        issues.push(
          `unique constraint "${tableName}: (${uq})" exists in the database but not in the model`,
        );
      }
    }
  }

  for (const tableName of Object.keys(actual.tables)) {
    if (!expected.tables[tableName]) {
      issues.push(`table "${tableName}" exists in the database but not in the models`);
    }
  }

  return issues;
}

/** Map a PostgreSQL `information_schema` type name to the closest IR kind. */
function pgTypeToKind(dataType: string, udtName: string): ColumnType["kind"] {
  const t = dataType.toLowerCase();
  if (t === "user-defined") return "enum"; // a named enum type
  if (t === "smallint") return "smallint";
  if (t === "integer") return "integer";
  if (t === "bigint") return "bigint";
  if (t === "numeric") return "numeric";
  if (t === "real") return "real";
  if (t === "double precision") return "double";
  if (t === "character varying") return "varchar";
  if (t === "character") return "char";
  if (t === "text") return "text";
  if (t === "boolean") return "boolean";
  if (t === "date") return "date";
  if (t.startsWith("time")) return t.startsWith("timestamp") ? "timestamp" : "time";
  if (t === "bytea") return "blob";
  if (t === "json") return "json";
  if (t === "jsonb") return "json";
  if (t === "uuid") return "uuid";
  return udtName === "jsonb" ? "json" : "text";
}

/**
 * Read the current PostgreSQL schema into a `SchemaIR` from `information_schema`.
 *
 * Not exercised by the in-repo test suite (no PostgreSQL in CI); mirrors
 * {@link introspectSqlite} for the async driver.
 *
 * @param driver An async PostgreSQL driver.
 * @returns The introspected schema.
 */
export async function introspectPostgres(driver: AsyncDriver): Promise<SchemaIR> {
  const tablesResult = await driver.execute(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name != 'tempest_db_js_migrations'",
    [],
  );
  const tables: Record<string, TableIR> = {};
  for (const row of tablesResult.rows) {
    const tableName = String(row.table_name);
    const colsResult = await driver.execute(
      "SELECT column_name, data_type, udt_name, is_nullable FROM information_schema.columns WHERE table_name = $1",
      [tableName],
    );
    const pkResult = await driver.execute(
      `SELECT a.attname AS name FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary`,
      [tableName],
    );
    const pkSet = new Set(pkResult.rows.map((r) => String(r.name)));
    const columns: Record<string, ColumnIR> = {};
    const primaryKey: string[] = [];
    for (const col of colsResult.rows) {
      const name = String(col.column_name);
      const isPk = pkSet.has(name);
      columns[name] = {
        name,
        type: {
          kind: pgTypeToKind(String(col.data_type), String(col.udt_name)),
          meta: {},
        },
        notNull: col.is_nullable === "NO" || isPk,
        primaryKey: isPk,
        default: null,
        unique: false,
        references: null,
      };
      if (isPk) primaryKey.push(name);
    }
    tables[tableName] = {
      name: tableName,
      columns,
      primaryKey,
      uniqueConstraints: await postgresUniques(driver, tableName),
      foreignKeys: await postgresForeignKeys(driver, tableName),
    };
  }
  return { tables };
}

/** Read a table's foreign keys from `pg_constraint` (best-effort, no CI). */
async function postgresForeignKeys(
  driver: AsyncDriver,
  table: string,
): Promise<ForeignKeyIR[]> {
  const result = await driver.execute(
    `SELECT c.conname AS name,
            (SELECT array_agg(a.attname ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
            cf.relname AS ref_table,
            (SELECT array_agg(a.attname ORDER BY k.ord)
               FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS ref_cols
       FROM pg_constraint c
       JOIN pg_class cf ON cf.oid = c.confrelid
      WHERE c.contype = 'f' AND c.conrelid = $1::regclass`,
    [table],
  );
  return result.rows.map((r) => ({
    name: String(r.name),
    columns: (r.cols as string[]) ?? [],
    refTable: String(r.ref_table),
    refColumns: (r.ref_cols as string[]) ?? [],
  }));
}

/** Read a table's unique constraints from `pg_constraint` (best-effort, no CI). */
async function postgresUniques(
  driver: AsyncDriver,
  table: string,
): Promise<UniqueConstraintIR[]> {
  const result = await driver.execute(
    `SELECT c.conname AS name,
            (SELECT array_agg(a.attname ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols
       FROM pg_constraint c
      WHERE c.contype = 'u' AND c.conrelid = $1::regclass`,
    [table],
  );
  return result.rows.map((r) => ({
    name: String(r.name),
    columns: (r.cols as string[]) ?? [],
  }));
}

/**
 * Drift check for PostgreSQL: compares the live schema (introspected) against the
 * models by column kind, nullability, primary-key, and presence. Structural —
 * not exercised in CI (no PostgreSQL).
 *
 * @param driver An async PostgreSQL driver.
 * @param models The model classes that define the intended schema.
 * @returns A list of drift messages — empty means no drift.
 */
export async function checkDriftPostgres(
  driver: AsyncDriver,
  models: readonly ModelClass[],
): Promise<string[]> {
  const actual = await introspectPostgres(driver);
  const expected = reflectSchema(models);
  const issues: string[] = [];
  for (const [tableName, expectedTable] of Object.entries(expected.tables)) {
    const actualTable = actual.tables[tableName];
    if (!actualTable) {
      issues.push(`table "${tableName}" is missing from the database`);
      continue;
    }
    for (const [colName, expectedCol] of Object.entries(expectedTable.columns)) {
      const actualCol = actualTable.columns[colName];
      if (!actualCol) {
        issues.push(`column "${tableName}.${colName}" is missing from the database`);
        continue;
      }
      if (expectedCol.type.kind !== actualCol.type.kind) {
        issues.push(
          `column "${tableName}.${colName}" type differs: model ${expectedCol.type.kind}, db ${actualCol.type.kind}`,
        );
      }
      if (expectedCol.notNull !== actualCol.notNull) {
        issues.push(`column "${tableName}.${colName}" nullability differs`);
      }
    }
    for (const colName of Object.keys(actualTable.columns)) {
      if (!expectedTable.columns[colName]) {
        issues.push(
          `column "${tableName}.${colName}" exists in the database but not in the model`,
        );
      }
    }

    const expectedKeys = constraintKeys(expectedTable);
    const actualKeys = constraintKeys(actualTable);
    for (const fk of expectedKeys.fks) {
      if (!actualKeys.fks.has(fk)) {
        issues.push(`foreign key "${tableName}: ${fk}" is missing from the database`);
      }
    }
    for (const uq of expectedKeys.uniques) {
      if (!actualKeys.uniques.has(uq)) {
        issues.push(
          `unique constraint "${tableName}: (${uq})" is missing from the database`,
        );
      }
    }
  }
  for (const tableName of Object.keys(actual.tables)) {
    if (!expected.tables[tableName]) {
      issues.push(`table "${tableName}" exists in the database but not in the models`);
    }
  }
  return issues;
}
