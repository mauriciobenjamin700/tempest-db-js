/**
 * tempest-db-js — common table expressions (`WITH`).
 *
 * A CTE names a query so the rest of the statement can select from it, and —
 * when it is recursive — so it can select from **itself**. That second form is
 * the only way to walk a tree (a category hierarchy, a reply chain, a dependency
 * graph) in one statement instead of one query per level.
 *
 * The alias is a real model class with the CTE's name as its table, so everything
 * that already takes a model — `select`, `join`, `where` — takes a CTE with no
 * special casing anywhere else.
 */

import type { InferModel, ModelClass, NamingStrategy } from "./index.js";
import { type SelectBuilder, type SelectNode, select } from "./query.js";
import type { SetBuilder, SetNode } from "./setops.js";

/** A query that can be the body of a CTE. */
/* biome-ignore lint/suspicious/noExplicitAny: any select or set shape may be a body. */
export type CteBody<Row> = SelectBuilder<any, Row, any> | SetBuilder<Row>;

/** One `WITH` entry, as the AST carries it. */
export interface CteNode {
  /** The name the rest of the statement refers to. */
  readonly name: string;
  /** True for `WITH RECURSIVE`. */
  readonly recursive: boolean;
  /** The body query. */
  readonly body: SelectNode | SetNode;
  /**
   * `MATERIALIZED` / `NOT MATERIALIZED`, or `null` to let the planner decide.
   * PostgreSQL 12+ only.
   */
  readonly materialized: boolean | null;
}

/** Options for {@link cte} and {@link cteRecursive}. */
export interface CteOptions {
  /**
   * Force (or forbid) materialization of the CTE.
   *
   * PostgreSQL 12+ inlines a CTE used once, which is usually what you want;
   * `true` pins the old behavior when the body is expensive and used twice.
   * Ignored where the dialect has no such syntax.
   */
  readonly materialized?: boolean;
}

/**
 * Build the model that reads from the CTE.
 *
 * Unlike {@link aliased}, the name here **is** the relation — `FROM "subtree"`,
 * not `FROM "categories" AS "subtree"` — so this does not mark the class as an
 * alias of the underlying table.
 *
 * @param model The model whose shape the CTE yields.
 * @param name The CTE's name.
 * @returns A model class reading from the CTE.
 */
function cteModel<C extends ModelClass>(model: C, name: string): C {
  const relation = class extends (model as unknown as new () => object) {};
  Object.defineProperty(relation, "tablename", { value: name, writable: true });
  Object.defineProperty(relation, "naming", {
    value: (model as { naming?: NamingStrategy }).naming,
    writable: true,
  });
  Object.defineProperty(relation, "tableArgs", { value: undefined, writable: true });
  return relation as unknown as C;
}

/**
 * A named query, usable anywhere a model is.
 *
 * @typeParam C - the model class whose rows the CTE yields.
 */
export class Cte<C extends ModelClass> {
  constructor(
    /** The alias model: the same columns, under the CTE's name. */
    readonly model: C,
    /** The `WITH` entry this attaches to a statement. */
    readonly node: CteNode,
  ) {}

  /**
   * Select from the CTE, with the `WITH` clause attached.
   *
   * @param columns Optional projection.
   * @returns A builder over the CTE.
   */
  select(): SelectBuilder<InferModel<C>, InferModel<C>>;
  select<K extends keyof InferModel<C> & string>(
    columns: readonly K[],
  ): SelectBuilder<InferModel<C>, Pick<InferModel<C>, K>>;
  select(columns?: readonly string[]): SelectBuilder<unknown, unknown> {
    const builder = (columns
      ? select(this.model, columns as never)
      : select(this.model)) as unknown as SelectBuilder<unknown, unknown>;
    return attach(builder, this.node);
  }
}

/**
 * Attach a `WITH` entry to a builder that reads from the CTE.
 *
 * Use it when the outer query is not a plain `select(cte.model)` — a join, for
 * instance, whose builder was assembled elsewhere.
 *
 * @param builder The outer query.
 * @param node The `WITH` entry.
 * @returns The same builder shape, carrying the clause.
 */
export function attach<B extends { node: object }>(builder: B, node: CteNode): B {
  const current = (builder.node as { with?: readonly CteNode[] }).with ?? [];
  const next = { ...builder.node, with: [...current, node] };
  return Object.assign(Object.create(Object.getPrototypeOf(builder)), builder, {
    node: next,
  }) as B;
}

/**
 * A named query the rest of the statement can select from.
 *
 * @param name The CTE's name.
 * @param model The model whose row shape the body yields.
 * @param body The query to name.
 * @param options Materialization hint.
 * @returns The CTE, whose `.model` is usable anywhere a model is.
 *
 * @example
 * ```ts
 * const recent = cte("recent", Order, select(Order).where({ createdAt: { gte: since } }));
 * const rows = await session.execute(recent.select().where({ status: "open" })).all();
 * // WITH "recent" AS (SELECT * FROM "orders" WHERE ...) SELECT * FROM "recent" WHERE ...
 * ```
 */
export function cte<C extends ModelClass>(
  name: string,
  model: C,
  body: CteBody<InferModel<C>>,
  options?: CteOptions,
): Cte<C> {
  return new Cte(cteModel(model, name), {
    name,
    recursive: false,
    body: body.node as SelectNode | SetNode,
    materialized: options?.materialized ?? null,
  });
}

/**
 * A CTE whose body refers to itself — the way to walk a tree in one statement.
 *
 * The builder receives the CTE's own alias model, so the recursive branch can
 * join against it.
 *
 * @param name The CTE's name.
 * @param model The model whose row shape the body yields.
 * @param build Receives the self-reference and returns the body (a `union`/
 *   `unionAll` of the seed and the step).
 * @param options Materialization hint.
 * @returns The CTE.
 *
 * @example
 * ```ts
 * const subtree = cteRecursive("subtree", Category, (self) =>
 *   unionAll(
 *     select(Category).where({ id: rootId }),
 *     join(Category, "c").innerJoin(self, "s", { "c.parentId": "s.id" }).select("c"),
 *   ),
 * );
 * ```
 */
export function cteRecursive<C extends ModelClass>(
  name: string,
  model: C,
  build: (self: C) => CteBody<InferModel<C>>,
  options?: CteOptions,
): Cte<C> {
  const self = cteModel(model, name);
  return new Cte(self, {
    name,
    recursive: true,
    body: build(self).node as SelectNode | SetNode,
    materialized: options?.materialized ?? null,
  });
}
