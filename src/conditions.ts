/**
 * tempest-db-js — logical combinators for `where` (and/or/not).
 *
 * A `where` value is either the object form (an implicit AND of its fields) or a
 * `Condition` built with `and`/`or`/`not`. Both normalize to a `CondNode` tree
 * that every builder stores and the dialect compiles recursively — so select,
 * update, delete and join all share one condition language.
 */

import type { WhereInput } from "./query.js";

/** Field-map condition (implicit AND of its entries). */
export interface CondFields {
  readonly kind: "fields";
  readonly fields: Record<string, unknown>;
}

/** Logical condition nodes. */
export type CondNode =
  | CondFields
  | { readonly kind: "and"; readonly parts: readonly CondNode[] }
  | { readonly kind: "or"; readonly parts: readonly CondNode[] }
  | { readonly kind: "not"; readonly part: CondNode };

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
