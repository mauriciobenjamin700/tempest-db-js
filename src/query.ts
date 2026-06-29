/**
 * Querium — Phase 2 feasibility spike: the typed query builder.
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

/** Serializable AST for a SELECT. Dialects (Phase 4) compile this to SQL. */
export interface SelectNode {
  readonly kind: "select";
  readonly table: string;
  /** Projected columns, or "*" for the whole row. */
  readonly columns: readonly string[] | "*";
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
      where: undefined,
      orderBy: [],
      limit: undefined,
      offset: undefined,
    },
    model,
  );
}
