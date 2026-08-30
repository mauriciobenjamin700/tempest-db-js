/**
 * tempest-db-js — logical combinators for `where` (and/or/not).
 *
 * A `where` value is either the object form (an implicit AND of its fields) or a
 * `Condition` built with `and`/`or`/`not`. Both normalize to a `CondNode` tree
 * that every builder stores and the dialect compiles recursively — so select,
 * update, delete and join all share one condition language.
 */

import type { Operator, WhereInput } from "./query.js";

/** Field-map condition (implicit AND of its entries). */
export interface CondFields {
  readonly kind: "fields";
  readonly fields: Record<string, unknown>;
}

/**
 * One side of a comparison: a column reference, a bound value, or a SQL function
 * applied to other expressions.
 *
 * A column reference carries the **property** name, not the database column —
 * the dialect resolves it through the node's name map, so `col()` cannot become a
 * back door around an explicit `.name()` mapping.
 */
export type ExprNode =
  | { readonly kind: "column"; readonly name: string }
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "fn"; readonly name: string; readonly args: readonly ExprNode[] };

/** Logical condition nodes. */
export type CondNode =
  | CondFields
  | { readonly kind: "and"; readonly parts: readonly CondNode[] }
  | { readonly kind: "or"; readonly parts: readonly CondNode[] }
  | { readonly kind: "not"; readonly part: CondNode }
  | {
      readonly kind: "compare";
      readonly left: ExprNode;
      readonly op: Operator;
      readonly right: ExprNode;
    };

const CONDITION = Symbol.for("tempest-db-js.condition");

/** A composed condition produced by `and`/`or`/`not`. */
export interface Condition {
  readonly [CONDITION]: true;
  readonly node: CondNode;
}

/** Runtime guard: is this value a composed `Condition`? */
export function isCondition(value: unknown): value is Condition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[CONDITION] === true
  );
}

/** Normalize a where argument (object form or `Condition`) to a `CondNode`. */
export function toCondNode(input: Condition | Record<string, unknown>): CondNode {
  return isCondition(input) ? input.node : { kind: "fields", fields: input };
}

function wrap(node: CondNode): Condition {
  return { [CONDITION]: true, node };
}

/**
 * A `where` argument: the object form (keys typed against `Row`) or a `Condition`.
 *
 * @typeParam Row - the row type whose columns the field keys are checked against.
 *   Defaults to a permissive shape; pass it explicitly (e.g. `or<UserRow>(...)`)
 *   for full key + operator checking inside combinators.
 */
export type WhereArg<Row = Record<string, unknown>> = WhereInput<Row> | Condition;

/** Normalize a comparison operand: an {@link Expression}, or a bound value. */
function toExprNode(operand: unknown): ExprNode {
  return isExpression(operand) ? operand.node : { kind: "value", value: operand };
}

/**
 * Reject an {@link Expression} among operands that are bound as values.
 *
 * `IN` and `BETWEEN` bind their operands, so an expression slipped into the list
 * would be serialized by the driver instead of rendered as SQL — the same silent
 * corruption that `set()` guards against.
 *
 * @param op The operator name, for the message.
 * @param operands The operands to check.
 * @throws Error When any operand is an expression.
 */
function assertValueOperands(op: string, operands: readonly unknown[]): void {
  if (operands.some(isExpression)) {
    throw new Error(
      `The "${op}" operator binds its operands, so it takes values, not expressions.`,
    );
  }
}

/** Runtime guard: is this operand a built {@link Expression}? */
export function isExpression(value: unknown): value is Expression {
  return value instanceof Expression;
}

/**
 * One side of a comparison, built with {@link col}, {@link val} or {@link fn}.
 *
 * The comparison methods mirror the `where` operators, but both sides are
 * expressions — which is what makes `col("total").gt(col("paid"))` and a
 * functional-index lookup like `fn.lower("email").eq(fn.lower(val(probe)))`
 * expressible at all. An operand that is not an `Expression` is bound as a
 * parameter, so `.eq(probe)` stays safe by default.
 */
export class Expression {
  constructor(
    /** The expression AST the dialect renders. */
    readonly node: ExprNode,
  ) {}

  /** Compare this expression against another expression or a bound value. */
  private compare(op: Operator, operand: unknown): Condition {
    return wrap({ kind: "compare", left: this.node, op, right: toExprNode(operand) });
  }

  /** `=` (or `IS NULL` for a null value). */
  eq(operand: unknown): Condition {
    return this.compare("eq", operand);
  }
  /** `<>` (or `IS NOT NULL` for a null value). */
  ne(operand: unknown): Condition {
    return this.compare("ne", operand);
  }
  /** `>`. */
  gt(operand: unknown): Condition {
    return this.compare("gt", operand);
  }
  /** `>=`. */
  gte(operand: unknown): Condition {
    return this.compare("gte", operand);
  }
  /** `<`. */
  lt(operand: unknown): Condition {
    return this.compare("lt", operand);
  }
  /** `<=`. */
  lte(operand: unknown): Condition {
    return this.compare("lte", operand);
  }
  /** `LIKE` — `%` and `_` in the operand are wildcards. */
  like(pattern: string | Expression): Condition {
    return this.compare("like", pattern);
  }
  /** `ILIKE` — case-insensitive **pattern** matching, wildcards included. */
  ilike(pattern: string | Expression): Condition {
    return this.compare("ilike", pattern);
  }
  /** Case-insensitive equality (`lower(a) = lower(b)`), with no wildcards. */
  ieq(operand: unknown): Condition {
    return this.compare("ieq", operand);
  }
  /**
   * `IN (...)` over a list of values.
   *
   * @param values The values to test against.
   * @returns The condition.
   * @throws Error When an entry is an {@link Expression} — a list operand is
   *   bound, so an expression there would be serialized as a parameter instead of
   *   rendered as SQL.
   */
  in(values: readonly unknown[]): Condition {
    assertValueOperands("in", values);
    return this.compare("in", values);
  }
  /**
   * `NOT IN (...)` over a list of values.
   *
   * @param values The values to exclude.
   * @returns The condition.
   * @throws Error When an entry is an {@link Expression} (see {@link Expression.in}).
   */
  notIn(values: readonly unknown[]): Condition {
    assertValueOperands("notIn", values);
    return this.compare("notIn", values);
  }
  /**
   * `BETWEEN lo AND hi` (inclusive).
   *
   * @param lo The lower bound.
   * @param hi The upper bound.
   * @returns The condition.
   * @throws Error When a bound is an {@link Expression} (see {@link Expression.in}).
   */
  between(lo: unknown, hi: unknown): Condition {
    assertValueOperands("between", [lo, hi]);
    return this.compare("between", [lo, hi]);
  }
  /** `IS NULL` (true) / `IS NOT NULL` (false). */
  isNull(value = true): Condition {
    return this.compare("isNull", value);
  }
}

/**
 * A column reference, by **property** name.
 *
 * Pass the row type for key-safety: `col<UserRow>("total")` rejects a name that
 * is not a column. The name is resolved through the model's column-name map at
 * compile time, exactly like the object form of `where`.
 *
 * @param name The model property name.
 * @returns An expression referencing that column.
 *
 * @example
 * ```ts
 * select(Order).where(col<OrderRow>("total").gt(col<OrderRow>("paid")));
 * // SELECT * FROM "orders" WHERE "total" > "paid"
 * ```
 */
export function col<Row = Record<string, unknown>>(name: keyof Row & string): Expression {
  return new Expression({ kind: "column", name });
}

/**
 * A bound value, for the places that take an expression and would otherwise read
 * a bare string as a column name (the arguments of {@link fn}).
 *
 * @param value The value to bind as a parameter.
 * @returns An expression that renders as a placeholder.
 */
export function val(value: unknown): Expression {
  return new Expression({ kind: "value", value });
}

/** Function names are interpolated verbatim, so they must be plain identifiers. */
const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Coerce a function argument: a bare string is a column, everything else a value. */
function toArg(arg: Expression | string): ExprNode {
  return typeof arg === "string" ? { kind: "column", name: arg } : arg.node;
}

/**
 * Build a call to a SQL function.
 *
 * A bare string argument is a **column name** — that is the useful default here
 * (`fn.lower("username")`), and it is why a literal has to be wrapped in
 * {@link val}. The function name is interpolated into the statement, so it is
 * validated as a plain identifier and must never come from user input; the
 * arguments are always rendered through the expression compiler.
 *
 * @param name The SQL function name.
 * @param args Column names or expressions.
 * @returns An expression for the call.
 * @throws Error When `name` is not a plain SQL identifier.
 */
function call(name: string, ...args: (Expression | string)[]): Expression {
  if (!FUNCTION_NAME.test(name)) {
    throw new Error(
      `fn.call() takes a plain SQL function name; got ${JSON.stringify(name)}.`,
    );
  }
  return new Expression({ kind: "fn", name, args: args.map(toArg) });
}

/**
 * SQL functions usable on either side of a comparison.
 *
 * The named entries are the ones every supported dialect implements. Anything
 * else — `date_trunc`, `strftime`, a custom function — goes through
 * {@link fn.call}, which does not pretend to be portable.
 *
 * @example
 * ```ts
 * select(AdminUser).where(fn.lower("username").eq(fn.lower(val(probe))));
 * // WHERE lower("username") = lower($1)
 * ```
 */
export const fn = {
  /** `lower(x)`. */
  lower: (arg: Expression | string): Expression => call("lower", arg),
  /** `upper(x)`. */
  upper: (arg: Expression | string): Expression => call("upper", arg),
  /** `trim(x)`. */
  trim: (arg: Expression | string): Expression => call("trim", arg),
  /** `length(x)`. */
  length: (arg: Expression | string): Expression => call("length", arg),
  /** `abs(x)`. */
  abs: (arg: Expression | string): Expression => call("abs", arg),
  /** `coalesce(a, b, ...)`. */
  coalesce: (...args: (Expression | string)[]): Expression => call("coalesce", ...args),
  /**
   * Any other SQL function, by name. Portability is the caller's problem —
   * `date_trunc` is PostgreSQL, `strftime` is SQLite.
   */
  call,
} as const;

/** Combine conditions with `AND`. */
export function and<Row = Record<string, unknown>>(
  ...inputs: WhereArg<NoInfer<Row>>[]
): Condition {
  return wrap({
    kind: "and",
    parts: inputs.map((i) => toCondNode(i as Record<string, unknown>)),
  });
}

/** Combine conditions with `OR`. */
export function or<Row = Record<string, unknown>>(
  ...inputs: WhereArg<NoInfer<Row>>[]
): Condition {
  return wrap({
    kind: "or",
    parts: inputs.map((i) => toCondNode(i as Record<string, unknown>)),
  });
}

/** Negate a condition with `NOT`. */
export function not<Row = Record<string, unknown>>(
  input: WhereArg<NoInfer<Row>>,
): Condition {
  return wrap({ kind: "not", part: toCondNode(input as Record<string, unknown>) });
}
