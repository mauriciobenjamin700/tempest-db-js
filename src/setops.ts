/**
 * tempest-db-js — set operations (`UNION`, `INTERSECT`, `EXCEPT`).
 *
 * Combining two queries in any way other than a join meant dropping to
 * `session.raw`, losing the row type, the coercion and the composition. A set
 * operation is also the one place a typed builder can catch a mistake the
 * database only reports at runtime: branches whose projections do not line up.
 */

import type { ModelClass } from "./index.js";
import type { JoinNode } from "./join.js";
import type { OrderTerm, SelectNode, SortDirection } from "./query.js";

/** Which set operation combines the branches. */
export type SetOperator = "union" | "unionAll" | "intersect" | "except";

/** Serializable AST for a set operation. */
export interface SetNode {
  readonly kind: "set_op";
  readonly op: SetOperator;
  /** The combined SELECTs, in order. A branch may be a join projecting one source. */
  readonly branches: readonly (SelectNode | JoinNode)[];
  /** Ordering applied to the **result**, not to a branch. */
  readonly orderBy: readonly OrderTerm[];
  readonly limit: number | undefined;
  readonly offset: number | undefined;
}

/**
 * A combined query, executable like a `SelectBuilder`.
 *
 * `orderBy` / `limit` / `offset` here apply to the **combined** result, which is
 * what SQL does: a branch that needs its own limit keeps it, and the dialect
 * parenthesizes that branch.
 *
 * @typeParam Row - the row type every branch projects.
 */
export class SetBuilder<Row> {
  /** Phantom: the result element type, read only by the type system. */
  declare readonly __row: Row;

  constructor(
    readonly node: SetNode,
    /** The first branch's model, used to coerce the returned rows. */
    readonly source: ModelClass,
  ) {}

  private with(patch: Partial<SetNode>): SetBuilder<Row> {
    return new SetBuilder<Row>({ ...this.node, ...patch }, this.source);
  }

  /**
   * Order the combined result.
   *
   * @param column A column of the projected row.
   * @param direction Sort direction (default ascending).
   * @returns A builder carrying the ordering.
   */
  orderBy(column: keyof Row & string, direction: SortDirection = "asc"): SetBuilder<Row> {
    return this.with({ orderBy: [...this.node.orderBy, { column, direction }] });
  }

  /** Limit the combined result. */
  limit(count: number): SetBuilder<Row> {
    return this.with({ limit: count });
  }

  /** Skip rows of the combined result. */
  offset(count: number): SetBuilder<Row> {
    return this.with({ offset: count });
  }
}

/**
 * What a set operation combines: anything that compiles to a SELECT and yields
 * `Row` — a `select()`, or a join narrowed to one source with `.pick()`.
 */
export interface Branch<Row> {
  /** The branch's AST. */
  readonly node: SelectNode | JoinNode;
  /** Phantom: the row type this branch yields. */
  readonly __row: Row;
  /** The model rows are coerced through, when the branch has a single source. */
  readonly source?: ModelClass;
  /** Source models by alias, for a join branch. */
  readonly sources?: Readonly<Record<string, ModelClass>>;
}

/**
 * The model a branch's rows should be coerced through.
 *
 * @param branch The branch.
 * @returns Its model, or `undefined` when it has none to offer.
 */
function branchSource(branch: Branch<unknown>): ModelClass | undefined {
  if (branch.source) return branch.source;
  const pick = (branch.node as JoinNode).pick;
  return pick ? branch.sources?.[pick] : undefined;
}

/**
 * Build a set operation over two or more branches.
 *
 * @param op The operator.
 * @param branches The SELECTs to combine.
 * @returns The combined builder.
 * @throws Error When fewer than two branches are given.
 */
function combine<Row>(
  op: SetOperator,
  branches: readonly Branch<Row>[],
): SetBuilder<Row> {
  if (branches.length < 2) {
    throw new Error(`${op}() combines at least two queries.`);
  }
  const first = branches[0] as Branch<Row>;
  const source = branchSource(first as Branch<unknown>);
  if (!source) {
    throw new Error(
      `${op}(): the first branch must project a single source — narrow a join with .pick(alias).`,
    );
  }
  return new SetBuilder<Row>(
    {
      kind: "set_op",
      op,
      branches: branches.map((b) => b.node),
      orderBy: [],
      limit: undefined,
      offset: undefined,
    },
    source,
  );
}

/**
 * `UNION` — every row of either branch, **duplicates removed**.
 *
 * Every branch must project the same shape; that is checked at compile time here,
 * where the database would only report it at runtime.
 *
 * @param branches The queries to combine.
 * @returns The combined builder.
 *
 * @example
 * ```ts
 * union(
 *   select(Post, ["id", "createdAt"]).where({ authorId: me }),
 *   select(Comment, ["id", "createdAt"]).where({ authorId: me }),
 * ).orderBy("createdAt", "desc").limit(50);
 * ```
 */
export function union<Row>(...branches: Branch<Row>[]): SetBuilder<Row> {
  return combine("union", branches);
}

/**
 * `UNION ALL` — every row of either branch, duplicates **kept**.
 *
 * Cheaper than `UNION`, which has to sort or hash to deduplicate. Prefer it
 * whenever the branches cannot overlap.
 *
 * @param branches The queries to combine.
 * @returns The combined builder.
 */
export function unionAll<Row>(...branches: Branch<Row>[]): SetBuilder<Row> {
  return combine("unionAll", branches);
}

/**
 * `INTERSECT` — only the rows present in every branch.
 *
 * @param branches The queries to combine.
 * @returns The combined builder.
 */
export function intersect<Row>(...branches: Branch<Row>[]): SetBuilder<Row> {
  return combine("intersect", branches);
}

/**
 * `EXCEPT` — the rows of the first branch that are not in the others.
 *
 * @param branches The queries to combine.
 * @returns The combined builder.
 */
export function except<Row>(...branches: Branch<Row>[]): SetBuilder<Row> {
  return combine("except", branches);
}
