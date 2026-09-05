/**
 * tempest-db-js — Phase 6: the Schema IR (intermediate representation).
 *
 * A canonical, dialect-neutral description of a database schema. Every source of
 * truth — model reflection (here), migration replay, or DB introspection —
 * produces the SAME `SchemaIR`, so the differ compares like with like and SQL is
 * only ever emitted at the dialect edge (the anti-"SQL-stitching" core).
 */

import type { CondNode, ExprNode } from "../conditions.js";
import {
  type ColumnType,
  type DefaultValue,
  type FkAction,
  type ForeignKeyRef,
  type ModelClass,
  columnNamesOf,
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
  /** A column-level `UNIQUE` constraint. */
  readonly unique: boolean;
  /** A column-level foreign-key reference, or `null` for none. */
  readonly references: ForeignKeyRef | null;
}

/** A (composite) `UNIQUE` table constraint in the IR. */
export interface UniqueConstraintIR {
  readonly name: string;
  readonly columns: readonly string[];
}

/** A `CHECK` constraint in the IR. */
export interface CheckIR {
  readonly name: string;
  /** The invariant, in the condition language — comparable without parsing SQL. */
  readonly expression: CondNode;
}

/** An index in the IR. */
export interface IndexIR {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  /** The predicate of a partial index, or `null` for a full one. */
  readonly where: CondNode | null;
}

/** A (composite) foreign-key table constraint in the IR. */
export interface ForeignKeyIR {
  readonly name: string;
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
  readonly onDelete?: FkAction | undefined;
  readonly onUpdate?: FkAction | undefined;
}

/**
 * A named table-level constraint, tagged by kind. Carried whole by the
 * `add_constraint` / `drop_constraint` operations so each is reversible.
 */
export type NamedConstraint =
  | { readonly type: "unique"; readonly constraint: UniqueConstraintIR }
  | { readonly type: "foreignKey"; readonly constraint: ForeignKeyIR }
  | { readonly type: "check"; readonly constraint: CheckIR };

/** One table. */
export interface TableIR {
  readonly name: string;
  readonly columns: Record<string, ColumnIR>;
  /** Primary-key column names (composite = more than one). */
  readonly primaryKey: readonly string[];
  /** Table-level unique constraints (from `tableArgs`). */
  readonly uniqueConstraints: readonly UniqueConstraintIR[];
  /** Table-level foreign-key constraints (from `tableArgs`). */
  readonly foreignKeys: readonly ForeignKeyIR[];
  /** `CHECK` constraints (from `tableArgs`). */
  readonly checks: readonly CheckIR[];
  /** Indexes (from `tableArgs`). Not constraints: they live in their own DDL. */
  readonly indexes: readonly IndexIR[];
}

/** A whole schema, keyed by table name. */
export interface SchemaIR {
  readonly tables: Record<string, TableIR>;
}

/** Deterministic constraint name when the user did not supply one. */
function constraintName(
  prefix: "uq" | "fk" | "ck" | "ix",
  table: string,
  columns: readonly string[],
): string {
  return `${prefix}_${table}_${columns.join("_")}`;
}

/**
 * Rewrite a condition's column references from property names to column names.
 *
 * The IR lives in **database**-name space, so a `CHECK` written against
 * `idempotencyKey` has to come out as `idempotency_key` — otherwise the drift
 * check would compare a model-space expression against a database-space one and
 * report a difference that is not there.
 *
 * @param node The condition as written.
 * @param toColumn The property → column mapping.
 * @returns The same condition in database-name space.
 */
export function renameConditionColumns(
  node: CondNode,
  toColumn: (prop: string) => string,
): CondNode {
  const expr = (current: ExprNode): ExprNode => {
    switch (current.kind) {
      case "column":
        return { kind: "column", name: toColumn(current.name) };
      case "fn":
        return { ...current, args: current.args.map(expr) };
      case "cast":
        return { ...current, operand: expr(current.operand) };
      default:
        return current;
    }
  };
  switch (node.kind) {
    case "fields": {
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) {
        fields[toColumn(key)] = value;
      }
      return { kind: "fields", fields };
    }
    case "and":
    case "or":
      return {
        ...node,
        parts: node.parts.map((part) => renameConditionColumns(part, toColumn)),
      };
    case "not":
      return { kind: "not", part: renameConditionColumns(node.part, toColumn) };
    case "compare":
      return { ...node, left: expr(node.left), right: expr(node.right) };
    default:
      return node;
  }
}

/**
 * Reflect one model class into a `TableIR`.
 *
 * The IR is keyed by **database** column names, so a model that maps
 * `consumerName` to `consumer_name` produces the same IR that introspecting the
 * live database does — otherwise the drift check would report every renamed
 * column as missing.
 *
 * @param model The model class.
 * @returns The table IR in database-name space.
 */
export function reflectTable(model: ModelClass): TableIR {
  const names = columnNamesOf(model);
  const toColumn = (prop: string): string => names?.[prop] ?? prop;
  const columns: Record<string, ColumnIR> = {};
  const primaryKey: string[] = [];
  for (const [prop, col] of Object.entries(columnsOf(model))) {
    const isPk = col.flags.primaryKey;
    const name = toColumn(prop);
    columns[name] = {
      name,
      type: col.type,
      notNull: col.flags.notNull || isPk,
      primaryKey: isPk,
      default: col.defaultValue,
      unique: col.flags.unique,
      references: col.reference,
    };
    if (isPk) primaryKey.push(name);
  }

  const uniqueConstraints: UniqueConstraintIR[] = [];
  const foreignKeys: ForeignKeyIR[] = [];
  const checks: CheckIR[] = [];
  const indexes: IndexIR[] = [];
  for (const c of model.tableArgs?.() ?? []) {
    const cols = c.columns.map(toColumn);
    if (c.kind === "unique") {
      uniqueConstraints.push({
        name: c.name ?? constraintName("uq", model.tablename, cols),
        columns: cols,
      });
    } else if (c.kind === "check") {
      checks.push({
        name: c.name ?? constraintName("ck", model.tablename, cols),
        expression: renameConditionColumns(c.expression, toColumn),
      });
    } else if (c.kind === "index") {
      indexes.push({
        name: c.name ?? constraintName("ix", model.tablename, cols),
        columns: cols,
        unique: c.unique === true,
        where: c.where ? renameConditionColumns(c.where, toColumn) : null,
      });
    } else {
      foreignKeys.push({
        name: c.name ?? constraintName("fk", model.tablename, cols),
        columns: cols,
        refTable: c.refTable,
        refColumns: c.refColumns,
        onDelete: c.onDelete,
        onUpdate: c.onUpdate,
      });
    }
  }

  return {
    name: model.tablename,
    columns,
    primaryKey,
    uniqueConstraints,
    foreignKeys,
    checks,
    indexes,
  };
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
