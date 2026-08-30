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
import { renderPortableToken } from "./expressions.js";
import { type NameMap, type SqlExpression, isSqlExpression } from "./index.js";
import type { JoinNode } from "./join.js";
import type { DeleteNode, InsertNode, UpdateNode } from "./mutations.js";
import { type LockClause, OPERATORS, type SelectNode } from "./query.js";
import type { Dialect } from "./url.js";

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

/**
 * Collects bound parameters and renders placeholders in dialect style. Exposed
 * because dialect subclasses receive it when overriding clause rendering.
 */
export class Params {
  readonly values: unknown[] = [];

  constructor(private readonly placeholder: (index: number) => string) {}

  bind(value: unknown): string {
    this.values.push(value);
    return this.placeholder(this.values.length);
  }
}

/** True when any value written by an INSERT is a SQL expression, not a literal. */
function insertHasExpression(node: InsertNode): boolean {
  for (const row of node.values) {
    for (const value of Object.values(row)) {
      if (isSqlExpression(value)) return true;
    }
  }
  const update = node.onConflict?.update;
  if (update && update !== "nothing") {
    for (const value of Object.values(update)) {
      if (isSqlExpression(value)) return true;
    }
  }
  return false;
}

/**
 * Base SQL compiler shared by every dialect. Subclasses customize only what
 * actually differs between databases (placeholder syntax, `ILIKE` support).
 */
export abstract class BaseDialect {
  abstract readonly name: Dialect;

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
   * The SQL operator for an array containment/overlap test.
   *
   * Only PostgreSQL has native arrays; the other dialects throw rather than
   * emitting an operator that means something else there.
   *
   * @param op The array operator name.
   * @returns The SQL operator text.
   * @throws Error On a dialect without native array support.
   */
  protected arrayOperator(op: "contains" | "containedBy" | "overlaps"): string {
    throw new Error(
      `The "${op}" operator needs native array support, which ${this.name} does not have.`,
    );
  }

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

  /**
   * Render a qualified `alias.column` ref as `"alias"."column"`, translating the
   * property name to the real column name for that alias's model.
   *
   * @param ref The `alias.property` reference (a bare name is left unqualified).
   * @param names The node's per-alias name maps, if any source renames columns.
   * @returns The quoted, qualified identifier.
   */
  private qualify(
    ref: string,
    names?: Readonly<Record<string, NameMap>> | undefined,
  ): string {
    const dot = ref.indexOf(".");
    if (dot === -1) return this.quoteId(ref);
    const alias = ref.slice(0, dot);
    const prop = ref.slice(dot + 1);
    return `${this.quoteId(alias)}.${this.columnId(prop, names?.[alias])}`;
  }

  /**
   * Quote a column identifier, translating the model property name to the real
   * database column name first.
   *
   * `names` is `undefined` for a model that renames nothing — the overwhelmingly
   * common case — so this stays a single lookup plus the memoized quote.
   *
   * @param prop The model property name as written in the builder.
   * @param names The node's property → column map, if any.
   * @returns The quoted database identifier.
   */
  protected columnId(prop: string, names: NameMap | undefined): string {
    return this.quoteId(names?.[prop] ?? prop);
  }

  /**
   * Render a {@link SqlExpression} inline, binding the parameters it carries.
   *
   * This is what keeps `set({ attempts: sql.raw("attempts + 1") })` an expression
   * instead of a bound object: the fragment goes into the statement text, and
   * only a `sql.expr` template's interpolations become parameters.
   *
   * @param expr The branded expression.
   * @param params The parameter collector for the statement being compiled.
   * @returns The SQL text of the expression.
   */
  protected renderExpression(expr: SqlExpression, params: Params): string {
    const token = expr.expression;
    if (typeof token === "string") return renderPortableToken(token, this.name);
    if ("raw" in token) return token.raw;
    const parts = token.parts;
    let sql = parts[0] ?? "";
    for (let i = 1; i < parts.length; i++) {
      sql += `${params.bind(expr.params[i - 1])}${parts[i]}`;
    }
    return sql;
  }

  /** Render one write value: a SQL expression inline, anything else as a parameter. */
  protected renderValue(value: unknown, params: Params): string {
    return isSqlExpression(value)
      ? this.renderExpression(value, params)
      : params.bind(value);
  }

  /**
   * Render a row-level locking clause (`FOR UPDATE ...`).
   *
   * Standard on PostgreSQL and MySQL 8.0+; SQLite overrides it to throw.
   *
   * @param lock The locking clause from the node.
   * @returns The SQL text, leading space included.
   */
  protected renderLock(lock: LockClause): string {
    const strength = lock.strength === "update" ? "FOR UPDATE" : "FOR SHARE";
    const of =
      lock.of.length > 0 ? ` OF ${lock.of.map((t) => this.quoteId(t)).join(", ")}` : "";
    const wait =
      lock.wait === "skipLocked"
        ? " SKIP LOCKED"
        : lock.wait === "noWait"
          ? " NOWAIT"
          : "";
    return ` ${strength}${of}${wait}`;
  }

  // ---- statements -------------------------------------------------------

  private compileSelect(node: SelectNode, params: Params): string {
    const names = node.names;
    let cols: string;
    if (node.aggregates.length > 0) {
      // Grouped/aggregate query: SELECT group cols + `FN(col) AS "alias"`.
      const groupSel = node.groupBy.map((c) => this.columnId(c, names));
      const aggSel = node.aggregates.map((a) => {
        const inner = a.column === "*" ? "*" : this.columnId(a.column, names);
        return `${a.fn.toUpperCase()}(${inner}) AS ${this.quoteId(a.alias)}`;
      });
      cols = [...groupSel, ...aggSel].join(", ");
    } else {
      cols =
        node.columns === "*"
          ? "*"
          : node.columns.map((c) => this.columnId(c, names)).join(", ");
    }
    let sql = `SELECT ${node.distinct ? "DISTINCT " : ""}${cols} FROM ${this.quoteId(node.table)}`;

    const where = this.compileCondition(node.where, params, (k) =>
      this.columnId(k, names),
    );
    if (where) sql += ` WHERE ${where}`;

    if (node.groupBy.length > 0) {
      sql += ` GROUP BY ${node.groupBy.map((c) => this.columnId(c, names)).join(", ")}`;
    }

    if (node.orderBy.length > 0) {
      const terms = node.orderBy
        .map(
          (t) =>
            `${this.columnId(t.column, names)} ${t.direction === "desc" ? "DESC" : "ASC"}`,
        )
        .join(", ");
      sql += ` ORDER BY ${terms}`;
    }
    if (node.limit !== undefined) sql += ` LIMIT ${params.bind(node.limit)}`;
    if (node.offset !== undefined) sql += ` OFFSET ${params.bind(node.offset)}`;
    if (node.lock) {
      if (node.distinct || node.groupBy.length > 0 || node.aggregates.length > 0) {
        throw new Error(
          "FOR UPDATE / FOR SHARE cannot be combined with DISTINCT or an aggregate query — lock the underlying rows in a separate SELECT.",
        );
      }
      sql += this.renderLock(node.lock);
    }
    return sql;
  }

  /**
   * Compile an INSERT.
   *
   * Takes the cached fast path only when the statement text is a pure function of
   * its structure. A SQL expression among the values, or a conflict predicate,
   * makes the text depend on the values themselves — those compile uncached, in
   * SQL order, so placeholder positions stay correct.
   */
  private compileInsert(node: InsertNode, params: Params): string {
    const columns = node.values.length > 0 ? Object.keys(node.values[0] as object) : [];
    const conflict = node.onConflict;
    const cacheable =
      conflict?.targetWhere === undefined &&
      conflict?.updateWhere === undefined &&
      !insertHasExpression(node);
    if (!cacheable) return this.compileInsertDirect(node, columns, params);

    // Bind every value in row-major, column order. The SQL text is independent of
    // the values (a null becomes a placeholder like any other), so it depends only
    // on the structure — which lets us cache the template below.
    for (const row of node.values) {
      for (const c of columns) params.bind((row as Record<string, unknown>)[c] ?? null);
    }
    // ON CONFLICT DO UPDATE binds its SET values after the row values, in key order.
    const conflictCols =
      conflict && conflict.update !== "nothing" ? Object.keys(conflict.update) : [];
    for (const c of conflictCols) {
      params.bind((conflict?.update as Record<string, unknown>)[c]);
    }
    return this.insertTemplate(node, columns, conflictCols, params);
  }

  /**
   * Compile an INSERT without the template cache, rendering clauses in statement
   * order so every parameter is bound at the position it appears.
   *
   * @param node The insert node.
   * @param columns The column keys shared by every row.
   * @param params The parameter collector.
   * @returns The SQL text.
   */
  private compileInsertDirect(
    node: InsertNode,
    columns: readonly string[],
    params: Params,
  ): string {
    const names = node.names;
    const colSql = columns.map((c) => this.columnId(c, names)).join(", ");
    const rowsSql = node.values
      .map((row) => {
        const cells = columns.map((c) =>
          this.renderValue((row as Record<string, unknown>)[c] ?? null, params),
        );
        return `(${cells.join(", ")})`;
      })
      .join(", ");
    let sql = `INSERT INTO ${this.quoteId(node.table)} (${colSql}) VALUES ${rowsSql}`;
    if (node.onConflict) {
      const update = node.onConflict.update;
      const conflictCols = update === "nothing" ? [] : Object.keys(update);
      let cursor = 0;
      sql += this.renderConflict(
        node.onConflict,
        conflictCols,
        () => {
          const key = conflictCols[cursor++] as string;
          return this.renderValue((update as Record<string, unknown>)[key], params);
        },
        names,
        params,
      );
    }
    sql += this.compileReturning(node.returning, names);
    return sql;
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
    params: Params,
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

    const names = node.names;
    const colSql = columns.map((c) => this.columnId(c, names)).join(", ");
    let position = 0;
    const rowsSql = node.values
      .map(() => `(${columns.map(() => this.placeholder(++position)).join(", ")})`)
      .join(", ");
    let sql = `INSERT INTO ${this.quoteId(node.table)} (${colSql}) VALUES ${rowsSql}`;
    if (node.onConflict) {
      sql += this.renderConflict(
        node.onConflict,
        conflictCols,
        () => this.placeholder(++position),
        names,
        params,
      );
    }
    sql += this.compileReturning(node.returning, names);
    BaseDialect.insertTemplates.set(key, sql);
    return sql;
  }

  /**
   * Render the conflict-handling clause. Standard SQL (SQLite/PostgreSQL) uses
   * `ON CONFLICT (...) [WHERE predicate] DO NOTHING | DO UPDATE SET ... [WHERE ...]`;
   * MySQL overrides this.
   *
   * The index predicate is rendered before the `DO UPDATE` assignments because
   * that is where it sits in the statement, so its parameters bind first.
   *
   * @param onConflict The conflict clause from the node.
   * @param conflictCols The columns to overwrite on `DO UPDATE` (empty for nothing).
   * @param nextValue Yields the SQL for the next `DO UPDATE` assignment value.
   * @param names The node's property → column map, if any.
   * @param params The parameter collector, for the predicates.
   * @returns The SQL text, leading space included.
   */
  protected renderConflict(
    onConflict: NonNullable<InsertNode["onConflict"]>,
    conflictCols: readonly string[],
    nextValue: () => string,
    names: NameMap | undefined,
    params: Params,
  ): string {
    const idFor = (key: string): string => this.columnId(key, names);
    const target = onConflict.target.map(idFor).join(", ");
    const indexWhere = this.compileCondition(onConflict.targetWhere, params, idFor);
    const targetSql = indexWhere ? `(${target}) WHERE ${indexWhere}` : `(${target})`;
    if (onConflict.update === "nothing") return ` ON CONFLICT ${targetSql} DO NOTHING`;
    const assignments = conflictCols
      .map((c) => `${idFor(c)} = ${nextValue()}`)
      .join(", ");
    let sql = ` ON CONFLICT ${targetSql} DO UPDATE SET ${assignments}`;
    const updateWhere = this.compileCondition(onConflict.updateWhere, params, idFor);
    if (updateWhere) sql += ` WHERE ${updateWhere}`;
    return sql;
  }

  private compileUpdate(node: UpdateNode, params: Params): string {
    const names = node.names;
    const sets = Object.entries(node.set)
      .map(
        ([col, value]) =>
          `${this.columnId(col, names)} = ${this.renderValue(value, params)}`,
      )
      .join(", ");
    let sql = `UPDATE ${this.quoteId(node.table)} SET ${sets}`;
    const where = this.compileCondition(node.where, params, (k) =>
      this.columnId(k, names),
    );
    if (where) sql += ` WHERE ${where}`;
    sql += this.compileReturning(node.returning, names);
    return sql;
  }

  private compileDelete(node: DeleteNode, params: Params): string {
    const names = node.names;
    let sql = `DELETE FROM ${this.quoteId(node.table)}`;
    const where = this.compileCondition(node.where, params, (k) =>
      this.columnId(k, names),
    );
    if (where) sql += ` WHERE ${where}`;
    sql += this.compileReturning(node.returning, names);
    return sql;
  }

  private compileJoin(node: JoinNode, params: Params): string {
    const names = node.names;
    const cols = node.selections
      .map((s) => {
        const ref = `${s.alias}.${s.column}`;
        return `${this.qualify(ref, names)} AS ${this.quoteId(ref)}`;
      })
      .join(", ");
    let sql = `SELECT ${cols} FROM ${this.quoteId(node.base.table)} AS ${this.quoteId(node.base.alias)}`;
    for (const j of node.joins) {
      const kw = j.kind === "left" ? "LEFT JOIN" : "INNER JOIN";
      const on = j.on
        .map(([l, r]) => `${this.qualify(l, names)} = ${this.qualify(r, names)}`)
        .join(" AND ");
      sql += ` ${kw} ${this.quoteId(j.table)} AS ${this.quoteId(j.alias)} ON ${on}`;
    }
    const where = this.compileCondition(node.where, params, (k) =>
      this.qualify(k, names),
    );
    if (where) sql += ` WHERE ${where}`;
    if (node.orderBy.length > 0) {
      const terms = node.orderBy
        .map(
          (t) =>
            `${this.qualify(t.ref, names)} ${t.direction === "desc" ? "DESC" : "ASC"}`,
        )
        .join(", ");
      sql += ` ORDER BY ${terms}`;
    }
    if (node.limit !== undefined) sql += ` LIMIT ${params.bind(node.limit)}`;
    if (node.offset !== undefined) sql += ` OFFSET ${params.bind(node.offset)}`;
    return sql;
  }

  // ---- clauses ----------------------------------------------------------

  protected compileReturning(
    returning: readonly string[] | "*" | null,
    names?: NameMap | undefined,
  ): string {
    if (returning === null) return "";
    if (returning === "*") return " RETURNING *";
    return ` RETURNING ${returning.map((c) => this.columnId(c, names)).join(", ")}`;
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
      case "ieq":
        return operand === null
          ? `${id} IS NULL`
          : `lower(${id}) = lower(${params.bind(operand)})`;
      case "contains":
        return `${id} ${this.arrayOperator("contains")} ${params.bind(operand)}`;
      case "containedBy":
        return `${id} ${this.arrayOperator("containedBy")} ${params.bind(operand)}`;
      case "overlaps":
        return `${id} ${this.arrayOperator("overlaps")} ${params.bind(operand)}`;
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

  /**
   * SQLite has no row-level locking, so a lock request is an error rather than a
   * silently unlocked `SELECT` — a lock that does not exist only shows up as
   * duplicated work under production concurrency.
   */
  protected override renderLock(): string {
    throw new Error(
      "SQLite has no row-level locking — FOR UPDATE / FOR SHARE is unsupported. Serialize the claim inside a transaction instead.",
    );
  }
}

/** PostgreSQL dialect: `$1` placeholders; native `ILIKE`; native array operators. */
export class PostgresDialect extends BaseDialect {
  readonly name = "postgresql" as const;

  protected placeholder(index: number): string {
    return `$${index}`;
  }

  protected ilike(column: string, param: string): string {
    return `${column} ILIKE ${param}`;
  }

  protected override arrayOperator(op: "contains" | "containedBy" | "overlaps"): string {
    if (op === "contains") return "@>";
    if (op === "containedBy") return "<@";
    return "&&";
  }
}

/** Backtick-quoted identifier cache for MySQL (its quoting differs from the base). */
const mysqlQuotedIds = new Map<string, string>();

/**
 * MySQL dialect: `?` placeholders, backtick identifiers, `ON DUPLICATE KEY
 * UPDATE` for upsert, and case-insensitive `LIKE` (default collation). MySQL has
 * no `RETURNING`, so requesting it throws.
 */
export class MysqlDialect extends BaseDialect {
  readonly name = "mysql" as const;

  protected placeholder(): string {
    return "?";
  }

  protected ilike(column: string, param: string): string {
    return `${column} LIKE ${param}`; // MySQL LIKE is case-insensitive by default
  }

  protected override quoteId(name: string): string {
    const cached = mysqlQuotedIds.get(name);
    if (cached !== undefined) return cached;
    const quoted = `\`${name.replace(/`/g, "``")}\``;
    mysqlQuotedIds.set(name, quoted);
    return quoted;
  }

  protected override renderConflict(
    onConflict: NonNullable<InsertNode["onConflict"]>,
    conflictCols: readonly string[],
    nextValue: () => string,
    names: NameMap | undefined,
  ): string {
    if (onConflict.targetWhere || onConflict.updateWhere) {
      throw new Error(
        "MySQL's ON DUPLICATE KEY UPDATE has no conflict-target predicate — a partial unique index is PostgreSQL/SQLite only.",
      );
    }
    if (onConflict.update === "nothing") {
      // MySQL has no DO NOTHING; a no-op self-assignment on a target column is
      // the idiomatic equivalent (keeps the existing row untouched).
      const col = this.columnId(onConflict.target[0] ?? "id", names);
      return ` ON DUPLICATE KEY UPDATE ${col} = ${col}`;
    }
    const assignments = conflictCols
      .map((c) => `${this.columnId(c, names)} = ${nextValue()}`)
      .join(", ");
    return ` ON DUPLICATE KEY UPDATE ${assignments}`;
  }

  protected override compileReturning(returning: readonly string[] | "*" | null): string {
    if (returning === null) return "";
    throw new Error(
      "RETURNING is not supported on MySQL — insert, then SELECT by key (e.g. LAST_INSERT_ID()).",
    );
  }
}

/** Get a dialect instance by name. */
export function getDialect(name: Dialect): BaseDialect {
  switch (name) {
    case "sqlite":
      return new SqliteDialect();
    case "postgresql":
      return new PostgresDialect();
    case "mysql":
      return new MysqlDialect();
  }
}
