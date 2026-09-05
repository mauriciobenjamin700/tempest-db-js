/**
 * tempest-db-js — window functions.
 *
 * The questions a `GROUP BY` cannot answer without a second query: the position
 * of a row inside its group, a running total, the difference to the previous row.
 * Without them, "top 3 per region" becomes one query per region — the N+1 of
 * reporting.
 */

import { type ExprNode, type Expression, expressionFromNode } from "./conditions.js";
import { Agg } from "./query.js";

/**
 * A function that is only legal **inside** a window.
 *
 * `row_number()` and `lag()` are errors without an `OVER` clause — SQLite says
 * "misuse of window function", PostgreSQL "window function ... requires an OVER
 * clause". Making them their own type means {@link over} is the only place they
 * can go, so the mistake does not compile instead of failing at runtime.
 */
export interface WindowFn<T = unknown> {
  /** The call node this wraps. */
  readonly call: ExprNode;
  /** Phantom: the value the function produces. */
  readonly __t?: T;
}

/** How a window is framed around the current row. */
export interface WindowSpec {
  /** Restart the window for each distinct value of these columns. */
  readonly partitionBy?: readonly string[];
  /** Order inside the window — what `rank` and a running total are computed over. */
  readonly orderBy?: readonly (string | readonly [string, "asc" | "desc"])[];
  /**
   * An explicit frame (`ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`).
   *
   * Omitted, the database's default applies — and the default is `RANGE`, which
   * for a running total lumps **every peer** of the current row together. When
   * rows share an `orderBy` value and that matters, say `ROWS` explicitly.
   */
  readonly frame?: string;
}

/** Turn a window function, aggregate or expression into the node a window wraps. */
function functionNode(fn: Expression | Agg<unknown> | WindowFn<unknown>): ExprNode {
  if ("call" in fn) return fn.call;
  if (fn instanceof Agg) {
    const arg: ExprNode =
      fn.column === "*"
        ? { kind: "star" }
        : typeof fn.column === "string"
          ? { kind: "column", name: fn.column }
          : fn.column;
    return { kind: "fn", name: fn.fn, args: [arg] };
  }
  return fn.node;
}

/**
 * Apply a function `OVER` a window.
 *
 * @param fn The window function ({@link rowNumber}, {@link lag}, …) or an
 *   aggregate (`sum("total")`) used as one.
 * @param spec Partitioning, ordering and framing.
 * @returns An expression usable in `compute`, `where` and `orderBy`.
 *
 * @example
 * ```ts
 * select(Sale).compute({
 *   rank: over(rowNumber(), { partitionBy: ["region"], orderBy: [["total", "desc"]] }),
 *   running: over(sum("total"), { partitionBy: ["region"], orderBy: ["date"] }),
 * });
 * ```
 */
export function over<T = unknown>(
  fn: WindowFn<T> | Expression<T> | Agg<T>,
  spec: WindowSpec = {},
): Expression<T> {
  return expressionFromNode<T>({
    kind: "window",
    fn: functionNode(fn as Expression | Agg<unknown> | WindowFn<unknown>),
    partitionBy: [...(spec.partitionBy ?? [])],
    orderBy: (spec.orderBy ?? []).map((term) =>
      typeof term === "string"
        ? { column: term, direction: "asc" as const }
        : { column: term[0], direction: term[1] },
    ),
    frame: spec.frame ?? null,
  });
}

/** Build a zero-argument window function. */
function windowFn<T>(name: string, args: readonly ExprNode[] = []): WindowFn<T> {
  return { call: { kind: "fn", name, args } };
}

/** `row_number()` — 1, 2, 3 … within the window, with no ties. */
export function rowNumber(): WindowFn<number> {
  return windowFn<number>("row_number");
}

/** `rank()` — ties share a position, and the next one skips (1, 1, 3). */
export function rank(): WindowFn<number> {
  return windowFn<number>("rank");
}

/** `dense_rank()` — ties share a position, and the next one does not skip (1, 1, 2). */
export function denseRank(): WindowFn<number> {
  return windowFn<number>("dense_rank");
}

/** `percent_rank()` — the rank as a fraction between 0 and 1. */
export function percentRank(): WindowFn<number> {
  return windowFn<number>("percent_rank");
}

/**
 * `lag(column, offset)` — the value from a row **behind** the current one.
 *
 * @param column The column to read.
 * @param offset How many rows back (default 1).
 * @returns The expression.
 */
export function lag<T = unknown>(column: string, offset = 1): WindowFn<T | null> {
  return windowFn<T | null>("lag", [
    { kind: "column", name: column },
    { kind: "value", value: offset },
  ]);
}

/**
 * `lead(column, offset)` — the value from a row **ahead** of the current one.
 *
 * @param column The column to read.
 * @param offset How many rows forward (default 1).
 * @returns The expression.
 */
export function lead<T = unknown>(column: string, offset = 1): WindowFn<T | null> {
  return windowFn<T | null>("lead", [
    { kind: "column", name: column },
    { kind: "value", value: offset },
  ]);
}

/** `first_value(column)` — the first value in the window. */
export function firstValue<T = unknown>(column: string): WindowFn<T | null> {
  return windowFn<T | null>("first_value", [{ kind: "column", name: column }]);
}

/** `last_value(column)` — the last value in the window (mind the default frame). */
export function lastValue<T = unknown>(column: string): WindowFn<T | null> {
  return windowFn<T | null>("last_value", [{ kind: "column", name: column }]);
}
