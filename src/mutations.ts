/**
 * Querium — Phase 2: typed INSERT / UPDATE / DELETE builders.
 *
 * Like `select`, these are PURE AST + phantom types — no database access. They
 * are executed in Phase 4 via `session.execute`.
 *
 * Safety rule: UPDATE and DELETE start in an *unguarded* type state. A builder
 * only becomes executable once it has a `.where(...)` clause or an explicit
 * `.unguarded()` opt-in. Phase 4's `session.execute` will accept only guarded
 * builders, making an accidental full-table write a compile error.
 */

import { type CondNode, type Condition, toCondNode } from "./conditions.js";
import type { InferInsert, InferModel, ModelClass } from "./index.js";
import type { WhereInput } from "./query.js";

// --------------------------------------------------------------------------
// shared
// --------------------------------------------------------------------------

/** Columns to return from a mutation, or "*" for the whole row. */
export type Returning = readonly string[] | "*" | null;

// --------------------------------------------------------------------------
// INSERT
// --------------------------------------------------------------------------

/** Serializable AST for an INSERT. */
export interface InsertNode {
  readonly kind: "insert";
  readonly table: string;
  readonly values: readonly Record<string, unknown>[];
  readonly returning: Returning;
}

/**
 * INSERT builder.
 *
 * @typeParam Full - the complete row type (for `returning`).
 * @typeParam Ins  - the insert shape (defaults/PK optional).
 * @typeParam Ret  - execution result: `number` (rows affected) until `returning`.
 */
export class InsertBuilder<Full, Ins, Ret = number> {
  declare readonly __row: Ret;

  constructor(
    readonly node: InsertNode,
    /** The source model, used to coerce returned rows on execution. */
    readonly source: ModelClass,
  ) {}

  private with<R>(patch: Partial<InsertNode>): InsertBuilder<Full, Ins, R> {
    return new InsertBuilder<Full, Ins, R>({ ...this.node, ...patch }, this.source);
  }

  /** Provide one row or many rows to insert, typed by the insert shape. */
  values(rows: Ins | readonly Ins[]): InsertBuilder<Full, Ins, Ret> {
    const list = (Array.isArray(rows) ? rows : [rows]) as readonly Record<
      string,
      unknown
    >[];
    return this.with<Ret>({ values: list });
  }

  /** Return the full inserted row(s). */
  returning(): InsertBuilder<Full, Ins, Full>;
  /** Return only the given columns of the inserted row(s). */
  returning<K extends keyof Full & string>(
    columns: readonly K[],
  ): InsertBuilder<Full, Ins, Pick<Full, K>>;
  returning(columns?: readonly string[]): InsertBuilder<Full, Ins, unknown> {
    return this.with<unknown>({ returning: columns ?? "*" });
  }
}

/** Build an INSERT into the model's table. */
export function insert<C extends ModelClass>(
  model: C,
): InsertBuilder<InferModel<C>, InferInsert<C>> {
  return new InsertBuilder(
    {
      kind: "insert",
      table: model.tablename,
      values: [],
      returning: null,
    },
    model,
  );
}

// --------------------------------------------------------------------------
// UPDATE
// --------------------------------------------------------------------------

/** Serializable AST for an UPDATE. */
export interface UpdateNode {
  readonly kind: "update";
  readonly table: string;
  readonly set: Record<string, unknown>;
  readonly where: CondNode | undefined;
  /** True once a where-clause or explicit opt-in makes the write safe. */
  readonly guarded: boolean;
  readonly returning: Returning;
}

/**
 * UPDATE builder.
 *
 * @typeParam Full     - the complete row type.
 * @typeParam Guarded  - `true` once safe to execute (has where or opted out).
 * @typeParam Ret      - execution result type.
 */
export class UpdateBuilder<Full, Guarded extends boolean, Ret = number> {
  declare readonly __row: Ret;
  declare readonly __guarded: Guarded;

  constructor(
    readonly node: UpdateNode,
    /** The source model, used to coerce returned rows on execution. */
    readonly source: ModelClass,
  ) {}

  private with<G extends boolean, R>(
    patch: Partial<UpdateNode>,
  ): UpdateBuilder<Full, G, R> {
    return new UpdateBuilder<Full, G, R>({ ...this.node, ...patch }, this.source);
  }

  /** The columns to write. Partial — only the given columns change. */
  set(values: Partial<Full>): UpdateBuilder<Full, Guarded, Ret> {
    return this.with<Guarded, Ret>({ set: values as Record<string, unknown> });
  }

  /** Restrict the rows to update. Marks the builder safe to execute. */
  where(input: WhereInput<Full> | Condition): UpdateBuilder<Full, true, Ret> {
    return this.with<true, Ret>({
      where: toCondNode(input as Record<string, unknown>),
      guarded: true,
    });
  }

  /** Explicit opt-in to update EVERY row. Use deliberately. */
  unguarded(): UpdateBuilder<Full, true, Ret> {
    return this.with<true, Ret>({ guarded: true });
  }

  /** Return the full updated row(s). */
  returning(): UpdateBuilder<Full, Guarded, Full>;
  /** Return only the given columns of the updated row(s). */
  returning<K extends keyof Full & string>(
    columns: readonly K[],
  ): UpdateBuilder<Full, Guarded, Pick<Full, K>>;
  returning(columns?: readonly string[]): UpdateBuilder<Full, Guarded, unknown> {
    return this.with<Guarded, unknown>({ returning: columns ?? "*" });
  }
}

/** Build an UPDATE on the model's table. Starts unguarded. */
export function update<C extends ModelClass>(
  model: C,
): UpdateBuilder<InferModel<C>, false> {
  return new UpdateBuilder(
    {
      kind: "update",
      table: model.tablename,
      set: {},
      where: undefined,
      guarded: false,
      returning: null,
    },
    model,
  );
}

// --------------------------------------------------------------------------
// DELETE
// --------------------------------------------------------------------------

/** Serializable AST for a DELETE. */
export interface DeleteNode {
  readonly kind: "delete";
  readonly table: string;
  readonly where: CondNode | undefined;
  readonly guarded: boolean;
  readonly returning: Returning;
}

/**
 * DELETE builder. Starts unguarded — same safety rule as UPDATE.
 *
 * @typeParam Full     - the complete row type.
 * @typeParam Guarded  - `true` once safe to execute.
 * @typeParam Ret      - execution result type.
 */
export class DeleteBuilder<Full, Guarded extends boolean, Ret = number> {
  declare readonly __row: Ret;
  declare readonly __guarded: Guarded;

  constructor(
    readonly node: DeleteNode,
    /** The source model, used to coerce returned rows on execution. */
    readonly source: ModelClass,
  ) {}

  private with<G extends boolean, R>(
    patch: Partial<DeleteNode>,
  ): DeleteBuilder<Full, G, R> {
    return new DeleteBuilder<Full, G, R>({ ...this.node, ...patch }, this.source);
  }

  /** Restrict the rows to delete. Marks the builder safe to execute. */
  where(input: WhereInput<Full> | Condition): DeleteBuilder<Full, true, Ret> {
    return this.with<true, Ret>({
      where: toCondNode(input as Record<string, unknown>),
      guarded: true,
    });
  }

  /** Explicit opt-in to delete EVERY row. Use deliberately. */
  unguarded(): DeleteBuilder<Full, true, Ret> {
    return this.with<true, Ret>({ guarded: true });
  }

  /** Return the full deleted row(s). */
  returning(): DeleteBuilder<Full, Guarded, Full>;
  /** Return only the given columns of the deleted row(s). */
  returning<K extends keyof Full & string>(
    columns: readonly K[],
  ): DeleteBuilder<Full, Guarded, Pick<Full, K>>;
  returning(columns?: readonly string[]): DeleteBuilder<Full, Guarded, unknown> {
    return this.with<Guarded, unknown>({ returning: columns ?? "*" });
  }
}

/** Build a DELETE on the model's table. Starts unguarded. */
export function del<C extends ModelClass>(model: C): DeleteBuilder<InferModel<C>, false> {
  return new DeleteBuilder(
    {
      kind: "delete",
      table: model.tablename,
      where: undefined,
      guarded: false,
      returning: null,
    },
    model,
  );
}
