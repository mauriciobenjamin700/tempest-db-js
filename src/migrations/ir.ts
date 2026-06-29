/**
 * tempest-db-js — Phase 6: the Schema IR (intermediate representation).
 *
 * A canonical, dialect-neutral description of a database schema. Every source of
 * truth — model reflection (here), migration replay, or DB introspection —
 * produces the SAME `SchemaIR`, so the differ compares like with like and SQL is
 * only ever emitted at the dialect edge (the anti-"SQL-stitching" core).
 */

import {
  type ColumnType,
  type DefaultValue,
  type ModelClass,
  columnsOf,
} from "../index.js";

/** A column's default in the IR. */
export type DefaultIR = DefaultValue | null;

/** One column. */
export interface ColumnIR {
  readonly name: string;
  readonly type: ColumnType;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly default: DefaultIR;
}

/** One table. */
export interface TableIR {
  readonly name: string;
  readonly columns: Record<string, ColumnIR>;
  /** Primary-key column names (composite = more than one). */
  readonly primaryKey: readonly string[];
}

/** A whole schema, keyed by table name. */
export interface SchemaIR {
  readonly tables: Record<string, TableIR>;
}

/** Reflect one model class into a `TableIR`. */
export function reflectTable(model: ModelClass): TableIR {
  const columns: Record<string, ColumnIR> = {};
  const primaryKey: string[] = [];
  for (const [name, col] of Object.entries(columnsOf(model))) {
    const isPk = col.flags.primaryKey;
    columns[name] = {
      name,
      type: col.type,
      notNull: col.flags.notNull || isPk,
      primaryKey: isPk,
      default: col.defaultValue,
    };
    if (isPk) primaryKey.push(name);
  }
  return { name: model.tablename, columns, primaryKey };
}

/**
 * Reflect a set of model classes into a `SchemaIR`. This is the **target** state
 * the differ compares the current (replayed) schema against.
 *
 * @param models The model classes that make up the schema.
 * @returns The reflected schema IR.
 */
export function reflectSchema(models: readonly ModelClass[]): SchemaIR {
  const tables: Record<string, TableIR> = {};
  for (const model of models) {
    const table = reflectTable(model);
    tables[table.name] = table;
  }
  return { tables };
}

/** An empty schema (the baseline before any migration). */
export function emptySchema(): SchemaIR {
  return { tables: {} };
}
