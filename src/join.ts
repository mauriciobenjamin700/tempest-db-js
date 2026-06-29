/**
 * Querium — Phase 5: typed joins with composite result types.
 *
 * `join(User, "user").innerJoin(Order, "order", { "user.id": "order.userId" })`
 * yields rows shaped `{ user: UserRow; order: OrderRow }`. A `leftJoin` makes the
 * joined side nullable (`OrderRow | null`), matching SQL outer-join semantics.
 *
 * Columns are aliased in SQL (`"user"."id" AS "user.id"`) so a flat driver row is
 * split back into one nested object per source, each coerced by its model.
 */

import { type CondNode, type Condition, toCondNode } from "./conditions.js";
import { type InferModel, type ModelClass, columnsOf } from "./index.js";
import type { SortDirection } from "./query.js";

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

/** One joined table. */
export interface JoinClause {
  readonly kind: "inner" | "left";
  readonly table: string;
  readonly alias: string;
  /** Equality pairs of qualified columns: `["user.id", "order.userId"]`. */
  readonly on: readonly (readonly [string, string])[];
}

/** A selected column, qualified by source alias. */
export interface JoinSelection {
  readonly alias: string;
  readonly column: string;
}

/** `where` filter for a join: keys are `alias.column` refs (object form). */
export type JoinWhereInput = Record<string, unknown>;

/** Serializable AST for a multi-table SELECT. */
export interface JoinNode {
  readonly kind: "join_select";
  readonly base: { readonly table: string; readonly alias: string };
  readonly joins: readonly JoinClause[];
  readonly selections: readonly JoinSelection[];
  readonly where: CondNode | undefined;
  readonly orderBy: readonly {
    readonly ref: string;
    readonly direction: SortDirection;
  }[];
  readonly limit: number | undefined;
  readonly offset: number | undefined;
}

// ---------------------------------------------------------------------------
// type helpers
// ---------------------------------------------------------------------------

/** A map of source alias → its (possibly nullable) row type. */
export type Sources = Record<string, object | null>;

/** Every `alias.column` reference across the current sources. */
export type ColRef<S extends Sources> = {
  [A in keyof S]: `${A & string}.${keyof NonNullable<S[A]> & string}`;
}[keyof S];

/** Valid `alias.column` references for a newly joined model. */
type RightRef<
  A extends string,
  C extends ModelClass,
> = `${A}.${keyof InferModel<C> & string}`;

/** The `on` condition: map existing-source refs to new-table refs (equality). */
export type JoinOn<S extends Sources, A extends string, C extends ModelClass> = Partial<
  Record<ColRef<S>, RightRef<A, C>>
>;

// ---------------------------------------------------------------------------
// builder
// ---------------------------------------------------------------------------

/** Build the qualified selection list for a model under an alias. */
function selectionsFor(alias: string, model: ModelClass): JoinSelection[] {
  return Object.keys(columnsOf(model)).map((column) => ({ alias, column }));
}

/**
 * Immutable, chainable multi-table SELECT builder.
 *
 * @typeParam S - the accumulated sources (alias → row type; nullable for left joins).
 */
export class JoinBuilder<S extends Sources> {
  /** Phantom: the composite result row type. */
  declare readonly __row: { [A in keyof S]: S[A] };

  constructor(
    readonly node: JoinNode,
    /** Source models keyed by alias, for SQL expansion and row coercion. */
    readonly sources: Readonly<Record<string, ModelClass>>,
  ) {}

  private add<S2 extends Sources>(
    clause: JoinClause,
    model: ModelClass,
  ): JoinBuilder<S2> {
    return new JoinBuilder<S2>(
      {
        ...this.node,
        joins: [...this.node.joins, clause],
        selections: [...this.node.selections, ...selectionsFor(clause.alias, model)],
      },
      { ...this.sources, [clause.alias]: model },
    );
  }

  private clause(
    kind: "inner" | "left",
    model: ModelClass,
    alias: string,
    on: Record<string, string>,
  ): JoinClause {
    return {
      kind,
      table: model.tablename,
      alias,
      on: Object.entries(on) as [string, string][],
    };
  }

  /** Inner join another model under `alias`. */
  innerJoin<C extends ModelClass, A extends string>(
    model: C,
    alias: A,
    on: JoinOn<S, A, C>,
  ): JoinBuilder<S & { [K in A]: InferModel<C> }> {
    return this.add(
      this.clause("inner", model, alias, on as Record<string, string>),
      model,
    );
  }

  /** Left (outer) join another model under `alias` — its side becomes nullable. */
  leftJoin<C extends ModelClass, A extends string>(
    model: C,
    alias: A,
    on: JoinOn<S, A, C>,
  ): JoinBuilder<S & { [K in A]: InferModel<C> | null }> {
    return this.add(
      this.clause("left", model, alias, on as Record<string, string>),
      model,
    );
  }

  /** Filter by `alias.column` references (object form) or an `and`/`or`/`not`. */
  where(input: Partial<Record<ColRef<S>, unknown>> | Condition): JoinBuilder<S> {
    return new JoinBuilder<S>(
      { ...this.node, where: toCondNode(input as Record<string, unknown>) },
      this.sources,
    );
  }

  /** Order by an `alias.column` reference. */
  orderBy(ref: ColRef<S>, direction: SortDirection = "asc"): JoinBuilder<S> {
    return new JoinBuilder<S>(
      {
        ...this.node,
        orderBy: [...this.node.orderBy, { ref: ref as string, direction }],
      },
      this.sources,
    );
  }

  limit(n: number): JoinBuilder<S> {
    return new JoinBuilder<S>({ ...this.node, limit: n }, this.sources);
  }

  offset(n: number): JoinBuilder<S> {
    return new JoinBuilder<S>({ ...this.node, offset: n }, this.sources);
  }
}

// ---------------------------------------------------------------------------
// entrypoint
// ---------------------------------------------------------------------------

/**
 * Start a multi-table query from a base model under `alias`.
 *
 * @param model The base model.
 * @param alias The alias to key the base table's rows under in the result.
 * @returns A `JoinBuilder` with the base source registered.
 */
export function join<C extends ModelClass, A extends string>(
  model: C,
  alias: A,
): JoinBuilder<{ [K in A]: InferModel<C> }> {
  return new JoinBuilder(
    {
      kind: "join_select",
      base: { table: model.tablename, alias },
      joins: [],
      selections: selectionsFor(alias, model),
      where: undefined,
      orderBy: [],
      limit: undefined,
      offset: undefined,
    },
    { [alias]: model },
  );
}
