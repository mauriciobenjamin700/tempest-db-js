/**
 * tempest-db-js — Phase 4a: dialect SQL compilation.
 *
 * Turns the dialect-neutral AST (`SelectNode`, `InsertNode`, `UpdateNode`,
 * `DeleteNode` from Phases 1-2) into `{ sql, params }`. This is the ONLY place
 * SQL is produced — always parameterized (`?` for SQLite, `$1` for PostgreSQL),
 * never string interpolation, so it is injection-safe by construction.
 *
 * It does NOT touch a database — execution is Phase 4b (`session.execute`).
 */

import type { CondNode } from "./conditions.js";
import type { JoinNode } from "./join.js";
import type { DeleteNode, InsertNode, UpdateNode } from "./mutations.js";
import { OPERATORS, type SelectNode } from "./query.js";

/** A compiled, parameterized statement ready to hand to a driver. */
export interface CompiledQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Any compilable AST node. */
export type QueryNode = SelectNode | InsertNode | UpdateNode | DeleteNode | JoinNode;

const OPERATOR_SET: ReadonlySet<string> = new Set(OPERATORS);

/** True when a where-value is an operator object rather than a bare value. */
function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Date ||
    value instanceof Uint8Array
  ) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => OPERATOR_SET.has(k));
}

/** Collects bound parameters and renders placeholders in dialect style. */
class Params {
  readonly values: unknown[] = [];

  constructor(private readonly placeholder: (index: number) => string) {}

  bind(value: unknown): string {
    this.values.push(value);
    return this.placeholder(this.values.length);
  }
}

/**
 * Base SQL compiler shared by every dialect. Subclasses customize only what
 * actually differs between databases (placeholder syntax, `ILIKE` support).
 */
export abstract class BaseDialect {
  abstract readonly name: "sqlite" | "postgresql";

  /**
   * INSERT SQL templates keyed by structure (dialect|table|columns|rowCount|
   * returning). Shared across dialect instances — the key namespaces by dialect
   * name, and the placeholder text is dialect-specific but structure-determined.
   */
  private static readonly insertTemplates = new Map<string, string>();

  /** Quoted-identifier cache (see {@link quoteId}). Shared across dialects. */
  private static readonly quotedIds = new Map<string, string>();

  /** Render the n-th (1-based) placeholder. */
  protected abstract placeholder(index: number): string;

  /** Render a case-insensitive LIKE for the active dialect. */
  protected abstract ilike(column: string, param: string): string;

  /**
   * Quote an identifier (column/table) for the active dialect.
   *
   * Memoized: identifiers form a small, stable set (column/table names), but this
   * runs for every identifier on every compile. Caching the quoted form removes a
   * regex-replace + string allocation from the hot path. The standard double-quote
   * form is identical across both dialects, so one shared cache is correct.
   */
  protected quoteId(name: string): string {
    const cached = BaseDialect.quotedIds.get(name);
    if (cached !== undefined) return cached;
    const quoted = `"${name.replace(/"/g, '""')}"`;
    BaseDialect.quotedIds.set(name, quoted);
    return quoted;
  }

  /** Compile any node to `{ sql, params }`. */
  compile(node: QueryNode): CompiledQuery {
    const params = new Params((i) => this.placeholder(i));
    let sql: string;
    switch (node.kind) {
      case "select":
        sql = this.compileSelect(node, params);
        break;
      case "insert":
        sql = this.compileInsert(node, params);
        break;
      case "update":
        sql = this.compileUpdate(node, params);
        break;
      case "delete":
        sql = this.compileDelete(node, params);
        break;
      case "join_select":
        sql = this.compileJoin(node, params);
        break;
    }
    return { sql, params: params.values };
  }

  /** Render a qualified `alias.column` ref as `"alias"."column"`. */
  private qualify(ref: string): string {
    const dot = ref.indexOf(".");
    if (dot === -1) return this.quoteId(ref);
    return `${this.quoteId(ref.slice(0, dot))}.${this.quoteId(ref.slice(dot + 1))}`;
  }

  // ---- statements -------------------------------------------------------

  private compileSelect(node: SelectNode, params: Params): string {
    let cols: string;
    if (node.aggregates.length > 0) {
      // Grouped/aggregate query: SELECT group cols + `FN(col) AS "alias"`.
      const groupSel = node.groupBy.map((c) => this.quoteId(c));
      const aggSel = node.aggregates.map((a) => {
        const inner = a.column === "*" ? "*" : this.quoteId(a.column);
        return `${a.fn.toUpperCase()}(${inner}) AS ${this.quoteId(a.alias)}`;
      });
      cols = [...groupSel, ...aggSel].join(", ");
    } else {
      cols =
        node.columns === "*" ? "*" : node.columns.map((c) => this.quoteId(c)).join(", ");
    }
    let sql = `SELECT ${node.distinct ? "DISTINCT " : ""}${cols} FROM ${this.quoteId(node.table)}`;

    const where = this.compileCondition(node.where, params, (k) => this.quoteId(k));
    if (where) sql += ` WHERE ${where}`;

    if (node.groupBy.length > 0) {
      sql += ` GROUP BY ${node.groupBy.map((c) => this.quoteId(c)).join(", ")}`;
    }

    if (node.orderBy.length > 0) {
      const terms = node.orderBy
        .map(
          (t) => `${this.quoteId(t.column)} ${t.direction === "desc" ? "DESC" : "ASC"}`,
        )
        .join(", ");
      sql += ` ORDER BY ${terms}`;
    }
    if (node.limit !== undefined) sql += ` LIMIT ${params.bind(node.limit)}`;
    if (node.offset !== undefined) sql += ` OFFSET ${params.bind(node.offset)}`;
    return sql;
  }

  private compileInsert(node: InsertNode, params: Params): string {
    const columns = node.values.length > 0 ? Object.keys(node.values[0] as object) : [];
    // Bind every value in row-major, column order. The SQL text is independent of
    // the values (a null becomes a placeholder like any other), so it depends only
    // on the structure — which lets us cache the template below.
    for (const row of node.values) {
      for (const c of columns) params.bind((row as Record<string, unknown>)[c] ?? null);
    }
    // ON CONFLICT DO UPDATE binds its SET values after the row values, in key order.
    const conflictCols =
      node.onConflict && node.onConflict.update !== "nothing"
        ? Object.keys(node.onConflict.update)
        : [];
    for (const c of conflictCols) {
      params.bind((node.onConflict?.update as Record<string, unknown>)[c]);
    }
    return this.insertTemplate(node, columns, conflictCols);
  }

  /**
   * The INSERT SQL template for a given structure, cached across calls.
   *
   * The text depends only on (dialect, table, columns, row count, returning,
   * conflict shape) — never on the bound values — and placeholder positions are
   * deterministic from the counts (a fresh statement always starts binding at 1).
   * So a per-row insert loop compiles the string once and reuses it every row.
   */
  private insertTemplate(
    node: InsertNode,
    columns: readonly string[],
    conflictCols: readonly string[],
  ): string {
    const returningKey =
      node.returning === null
        ? ""
        : node.returning === "*"
          ? "*"
          : node.returning.join(",");
    const conflictKey = node.onConflict
      ? `${node.onConflict.target.join(",")}>${node.onConflict.update === "nothing" ? "nothing" : conflictCols.join(",")}`
      : "";
    const key = `${this.name}|${node.table}|${columns.join(",")}|${node.values.length}|${returningKey}|${conflictKey}`;
    const cached = BaseDialect.insertTemplates.get(key);
    if (cached !== undefined) return cached;

    const colSql = columns.map((c) => this.quoteId(c)).join(", ");
    let position = 0;
    const rowsSql = node.values
      .map(() => `(${columns.map(() => this.placeholder(++position)).join(", ")})`)
      .join(", ");
    let sql = `INSERT INTO ${this.quoteId(node.table)} (${colSql}) VALUES ${rowsSql}`;
    if (node.onConflict) {
      const target = node.onConflict.target.map((c) => this.quoteId(c)).join(", ");
      if (node.onConflict.update === "nothing") {
        sql += ` ON CONFLICT (${target}) DO NOTHING`;
      } else {
        const assignments = conflictCols
          .map((c) => `${this.quoteId(c)} = ${this.placeholder(++position)}`)
          .join(", ");
        sql += ` ON CONFLICT (${target}) DO UPDATE SET ${assignments}`;
      }
    }
    sql += this.compileReturning(node.returning);
    BaseDialect.insertTemplates.set(key, sql);
    return sql;
  }

  private compileUpdate(node: UpdateNode, params: Params): string {
    const sets = Object.entries(node.set)
      .map(([col, value]) => `${this.quoteId(col)} = ${params.bind(value)}`)
      .join(", ");
    let sql = `UPDATE ${this.quoteId(node.table)} SET ${sets}`;
    const where = this.compileCondition(node.where, params, (k) => this.quoteId(k));
    if (where) sql += ` WHERE ${where}`;
    sql += this.compileReturning(node.returning);
    return sql;
  }

  private compileDelete(node: DeleteNode, params: Params): string {
    let sql = `DELETE FROM ${this.quoteId(node.table)}`;
    const where = this.compileCondition(node.where, params, (k) => this.quoteId(k));
    if (where) sql += ` WHERE ${where}`;
    sql += this.compileReturning(node.returning);
    return sql;
  }

  private compileJoin(node: JoinNode, params: Params): string {
    const cols = node.selections
      .map((s) => {
        const ref = `${s.alias}.${s.column}`;
        return `${this.qualify(ref)} AS ${this.quoteId(ref)}`;
      })
      .join(", ");
    let sql = `SELECT ${cols} FROM ${this.quoteId(node.base.table)} AS ${this.quoteId(node.base.alias)}`;
    for (const j of node.joins) {
      const kw = j.kind === "left" ? "LEFT JOIN" : "INNER JOIN";
      const on = j.on
        .map(([l, r]) => `${this.qualify(l)} = ${this.qualify(r)}`)
        .join(" AND ");
      sql += ` ${kw} ${this.quoteId(j.table)} AS ${this.quoteId(j.alias)} ON ${on}`;
    }
    const where = this.compileCondition(node.where, params, (k) => this.qualify(k));
    if (where) sql += ` WHERE ${where}`;
    if (node.orderBy.length > 0) {
      const terms = node.orderBy
        .map((t) => `${this.qualify(t.ref)} ${t.direction === "desc" ? "DESC" : "ASC"}`)
        .join(", ");
      sql += ` ORDER BY ${terms}`;
    }
    if (node.limit !== undefined) sql += ` LIMIT ${params.bind(node.limit)}`;
    if (node.offset !== undefined) sql += ` OFFSET ${params.bind(node.offset)}`;
    return sql;
  }

  // ---- clauses ----------------------------------------------------------

  private compileReturning(returning: readonly string[] | "*" | null): string {
    if (returning === null) return "";
    if (returning === "*") return " RETURNING *";
    return ` RETURNING ${returning.map((c) => this.quoteId(c)).join(", ")}`;
  }

  /**
   * Compile a condition tree (fields / and / or / not) to SQL. `idFor` renders a
   * key to a quoted identifier — `quoteId` for single-table, `qualify` for joins —
   * so select/update/delete/join all share this one compiler.
   */
  private compileCondition(
    node: CondNode | undefined,
    params: Params,
    idFor: (key: string) => string,
  ): string {
    if (!node) return "";
    switch (node.kind) {
      case "fields": {
        const conditions: string[] = [];
        for (const [key, value] of Object.entries(node.fields)) {
          const id = idFor(key);
          if (isOperatorObject(value)) {
            for (const [op, operand] of Object.entries(value)) {
              conditions.push(this.compileOperator(id, op, operand, params));
            }
          } else {
            // bare value → equality (null → IS NULL)
            conditions.push(
              value === null ? `${id} IS NULL` : `${id} = ${params.bind(value)}`,
            );
          }
        }
        return conditions.join(" AND ");
      }
      case "and":
      case "or": {
        const parts = node.parts
          .map((p) => this.compileCondition(p, params, idFor))
          .filter((s) => s.length > 0);
        if (parts.length === 0) return "";
        const sep = node.kind === "and" ? " AND " : " OR ";
        return parts.map((p) => `(${p})`).join(sep);
      }
      case "not": {
        const inner = this.compileCondition(node.part, params, idFor);
        return inner ? `NOT (${inner})` : "";
      }
    }
  }

  private compileOperator(
    id: string,
    op: string,
    operand: unknown,
    params: Params,
  ): string {
    switch (op) {
      case "eq":
        return operand === null ? `${id} IS NULL` : `${id} = ${params.bind(operand)}`;
      case "ne":
        return operand === null
          ? `${id} IS NOT NULL`
          : `${id} <> ${params.bind(operand)}`;
      case "gt":
        return `${id} > ${params.bind(operand)}`;
      case "gte":
        return `${id} >= ${params.bind(operand)}`;
      case "lt":
        return `${id} < ${params.bind(operand)}`;
      case "lte":
        return `${id} <= ${params.bind(operand)}`;
      case "like":
        return `${id} LIKE ${params.bind(operand)}`;
      case "ilike":
        return this.ilike(id, params.bind(operand));
      case "in":
        return this.compileIn(id, operand as readonly unknown[], params, false);
      case "notIn":
        return this.compileIn(id, operand as readonly unknown[], params, true);
      case "between": {
        const [lo, hi] = operand as readonly [unknown, unknown];
        return `${id} BETWEEN ${params.bind(lo)} AND ${params.bind(hi)}`;
      }
      case "isNull":
        return operand ? `${id} IS NULL` : `${id} IS NOT NULL`;
      default:
        throw new Error(`Unknown operator ${JSON.stringify(op)}`);
    }
  }

  private compileIn(
    id: string,
    values: readonly unknown[],
    params: Params,
    negate: boolean,
  ): string {
    if (values.length === 0) {
      // empty IN matches nothing; empty NOT IN matches everything
      return negate ? "1 = 1" : "1 = 0";
    }
    const list = values.map((v) => params.bind(v)).join(", ");
    return `${id} ${negate ? "NOT IN" : "IN"} (${list})`;
  }
}

/** SQLite dialect: `?` placeholders; `ILIKE` falls back to `LIKE` (ASCII-insensitive). */
export class SqliteDialect extends BaseDialect {
  readonly name = "sqlite" as const;

  protected placeholder(): string {
    return "?";
  }

  protected ilike(column: string, param: string): string {
    return `${column} LIKE ${param}`;
  }
}

/** PostgreSQL dialect: `$1` placeholders; native `ILIKE`. */
export class PostgresDialect extends BaseDialect {
  readonly name = "postgresql" as const;

  protected placeholder(index: number): string {
    return `$${index}`;
  }

  protected ilike(column: string, param: string): string {
    return `${column} ILIKE ${param}`;
  }
}

/** Get a dialect instance by name. */
export function getDialect(name: "sqlite" | "postgresql"): BaseDialect {
  return name === "sqlite" ? new SqliteDialect() : new PostgresDialect();
}
