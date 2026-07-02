/**
 * tempest-db-js — Phase 2 feasibility spike: the typed query builder.
 *
 * The builder is PURE AST + phantom types. It does not touch a database — that is
 * Phase 4 (`session.execute`). This file proves that:
 *   - `select(User)` infers the full row type,
 *   - `select(User, ["id", "name"])` infers a `Pick` projection,
 *   - `.where(...)` / `.orderBy(...)` reject keys that are not columns,
 * all at compile time.
 *
 * This is a SPIKE, not the final API.
 */

import { type CondNode, type Condition, toCondNode } from "./conditions.js";
import type { InferModel, ModelClass } from "./index.js";

// --------------------------------------------------------------------------
// AST
// --------------------------------------------------------------------------

/** Sort direction for ORDER BY. */
export type SortDirection = "asc" | "desc";

/** One ORDER BY term. */
export interface OrderTerm {
  readonly column: string;
  readonly direction: SortDirection;
}

/** One aggregate expression in a grouped SELECT (`COUNT(*) AS "n"`). */
export interface AggregateTerm {
  readonly fn: "count" | "sum" | "avg" | "min" | "max";
  /** The column to aggregate, or `"*"` (only valid for `count`). */
  readonly column: string | "*";
  /** The result alias. */
  readonly alias: string;
}

/** Serializable AST for a SELECT. Dialects (Phase 4) compile this to SQL. */
export interface SelectNode {
  readonly kind: "select";
  readonly table: string;
  /** Projected columns, or "*" for the whole row. */
  readonly columns: readonly string[] | "*";
  /** Emit `SELECT DISTINCT` when true. */
  readonly distinct: boolean;
  /** Aggregate expressions; when non-empty, this is a grouped/aggregate query. */
  readonly aggregates: readonly AggregateTerm[];
  /** `GROUP BY` columns. */
  readonly groupBy: readonly string[];
  readonly where: CondNode | undefined;
  readonly orderBy: readonly OrderTerm[];
  readonly limit: number | undefined;
  readonly offset: number | undefined;
}

// --------------------------------------------------------------------------
// where input typing (Phase 3 — operators typed per column type)
// --------------------------------------------------------------------------

/** Operators valid on every column type. */
interface BaseOperators<T> {
  /** Equal to. */
  eq?: T;
  /** Not equal to. */
  ne?: T;
  /** One of the given values (`IN`). */
  in?: readonly T[];
  /** None of the given values (`NOT IN`). */
  notIn?: readonly T[];
  /** `IS NULL` (true) / `IS NOT NULL` (false). */
  isNull?: boolean;
}

/** Extra operators for ordered types (numbers, bigint, dates). */
interface OrderedOperators<T> extends BaseOperators<T> {
  /** Greater than. */
  gt?: T;
  /** Greater than or equal. */
  gte?: T;
  /** Less than. */
  lt?: T;
  /** Less than or equal. */
  lte?: T;
  /** Inclusive range `BETWEEN lo AND hi`. */
  between?: readonly [T, T];
}

/** Extra operators for string-like types. */
interface StringOperators<T> extends BaseOperators<T> {
  /** `LIKE` pattern (case-sensitive). */
  like?: string;
  /** `ILIKE` pattern (case-insensitive). */
  ilike?: string;
}

/**
 * The operator object allowed for a column of (non-null) type `T`:
 *   - `string` → equality, `in`, `like`/`ilike`
 *   - `number` / `bigint` / `Date` → equality, `in`, ordered comparisons, `between`
 *   - `boolean` → equality, `isNull`
 *   - anything else (json/blob) → equality and `in` only
 */
export type OperatorsFor<T> = [T] extends [string]
  ? StringOperators<T>
  : [T] extends [number]
    ? OrderedOperators<T>
    : [T] extends [bigint]
      ? OrderedOperators<T>
      : [T] extends [Date]
        ? OrderedOperators<T>
        : [T] extends [boolean]
          ? BaseOperators<T>
          : BaseOperators<T>;

/**
 * `where` shape: each key must be a real column; each value accepts either a
 * bare value (shorthand for `eq`) or an operator object restricted to operators
 * valid for that column's type. A `like` on a `number` column, or `gt` on a
 * `string`, is a compile error.
 */
export type WhereInput<Row = Record<string, unknown>> = {
  [K in keyof Row]?: Row[K] | OperatorsFor<NonNullable<Row[K]>>;
};

/** The full set of operator keys, for the dialect compiler to recognize. */
export const OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "in",
  "notIn",
  "between",
  "isNull",
] as const;

/** One supported operator name. */
export type Operator = (typeof OPERATORS)[number];

// --------------------------------------------------------------------------
// aggregate expressions
// --------------------------------------------------------------------------

/** An aggregate expression carrying its result type `T` as a phantom. */
export class Agg<T> {
  declare readonly __t: T;
  constructor(
    readonly fn: AggregateTerm["fn"],
    readonly column: string | "*",
  ) {}
}

/** `COUNT(*)` — the number of rows in the group (never null). */
export function count(): Agg<number> {
  return new Agg<number>("count", "*");
}
/** `SUM(column)` — null when the group has no non-null values. */
export function sum(column: string): Agg<number | null> {
  return new Agg<number | null>("sum", column);
}
/** `AVG(column)` — null when the group has no non-null values. */
export function avg(column: string): Agg<number | null> {
  return new Agg<number | null>("avg", column);
}
/** `MIN(column)` — numeric columns; null on an empty group. */
export function min(column: string): Agg<number | null> {
  return new Agg<number | null>("min", column);
}
/** `MAX(column)` — numeric columns; null on an empty group. */
export function max(column: string): Agg<number | null> {
  return new Agg<number | null>("max", column);
}

/** Extract the phantom result type of an aggregate expression. */
type AggResult<A> = A extends Agg<infer T> ? T : never;

/** Flatten an intersection into a single object literal. */
type SimplifyProj<T> = { [K in keyof T]: T[K] } & {};

// --------------------------------------------------------------------------
// builder
// --------------------------------------------------------------------------

/**
 * Immutable, chainable SELECT builder.
 *
 * @typeParam Full - the complete row type (constrains where/orderBy keys).
 * @typeParam Proj - the projected result type returned on execution.
 */
export class SelectBuilder<Full, Proj = Full> {
  /** Phantom: the result element type, read only by the type system. */
  declare readonly __row: Proj;

  constructor(
    readonly node: SelectNode,
    /** The source model, used to coerce rows on execution. */
    readonly source: ModelClass,
  ) {}

  private with(patch: Partial<SelectNode>): SelectBuilder<Full, Proj> {
    return new SelectBuilder<Full, Proj>({ ...this.node, ...patch }, this.source);
  }

  /** Add a WHERE filter: the object form (keys typed) or an `and`/`or`/`not`. */
  where(input: WhereInput<Full> | Condition): SelectBuilder<Full, Proj> {
    return this.with({ where: toCondNode(input as Record<string, unknown>) });
  }

  /** Emit `SELECT DISTINCT` — drop duplicate rows. */
  distinct(): SelectBuilder<Full, Proj> {
    return this.with({ distinct: true });
  }

  /**
   * Group by columns and compute aggregates. The result row is the grouped
   * columns (typed from the model) plus one field per aggregate alias.
   *
   * @param groupBy The columns to group by (checked against the model). Pass `[]`
   *   for a whole-table aggregate.
   * @param spec A map of result alias → aggregate expression ({@link count},
   *   {@link sum}, {@link avg}, {@link min}, {@link max}).
   * @returns A builder whose row is `Pick<Full, K> & { [alias]: aggResult }`.
   *
   * @example
   * ```ts
   * select(Order).aggregate(["status"], { n: count(), total: sum("amount") });
   * // rows: { status: string; n: number; total: number | null }[]
   * ```
   */
  aggregate<K extends keyof Full & string, S extends Record<string, Agg<unknown>>>(
    groupBy: readonly K[],
    spec: S,
  ): SelectBuilder<
    Full,
    SimplifyProj<Pick<Full, K> & { [A in keyof S]: AggResult<S[A]> }>
  > {
    const aggregates: AggregateTerm[] = Object.entries(spec).map(([alias, agg]) => ({
      fn: agg.fn,
      column: agg.column,
      alias,
    }));
    return new SelectBuilder(
      { ...this.node, aggregates, groupBy },
      this.source,
    ) as unknown as SelectBuilder<
      Full,
      SimplifyProj<Pick<Full, K> & { [A in keyof S]: AggResult<S[A]> }>
    >;
  }

  /** Order by a column of `Full`. */
  orderBy(
    column: keyof Full & string,
    direction: SortDirection = "asc",
  ): SelectBuilder<Full, Proj> {
    return this.with({
      orderBy: [...this.node.orderBy, { column, direction }],
    });
  }

  /** Limit the number of rows. */
  limit(n: number): SelectBuilder<Full, Proj> {
    return this.with({ limit: n });
  }

  /** Skip the first `n` rows. */
  offset(n: number): SelectBuilder<Full, Proj> {
    return this.with({ offset: n });
  }
}

// --------------------------------------------------------------------------
// entrypoint
// --------------------------------------------------------------------------

/** Build a SELECT over every column of the model. */
export function select<C extends ModelClass>(
  model: C,
): SelectBuilder<InferModel<C>, InferModel<C>>;

/** Build a SELECT projecting only the given columns. */
export function select<C extends ModelClass, K extends keyof InferModel<C> & string>(
  model: C,
  columns: readonly K[],
): SelectBuilder<InferModel<C>, Pick<InferModel<C>, K>>;

export function select(
  model: ModelClass,
  columns?: readonly string[],
): SelectBuilder<unknown, unknown> {
  return new SelectBuilder(
    {
      kind: "select",
      table: model.tablename,
      columns: columns ?? "*",
      distinct: false,
      aggregates: [],
      groupBy: [],
      where: undefined,
      orderBy: [],
      limit: undefined,
      offset: undefined,
    },
    model,
  );
}
