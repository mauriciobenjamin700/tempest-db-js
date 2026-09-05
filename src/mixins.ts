/**
 * tempest-db-js — opt-in model mixins.
 *
 * The same four or five columns show up on every real table: when the row was
 * created and last touched, whether it was soft-deleted, who changed it. Writing
 * them out per model is repetition that drifts — one table gets `updated_at`
 * without `onUpdate`, another spells it `updatedOn`.
 *
 * These mixins are functions that take a base class and return a subclass
 * carrying the extra columns, mirroring `tempest-fastapi-sdk`'s
 * `SoftDeleteMixin` / `AuditMixin`. They compose:
 *
 * ```ts
 * class Order extends withSoftDelete(withTimestamps(Model)) {
 *   static override tablename = "orders";
 *   id = column.integer().primaryKey();
 * }
 * ```
 *
 * The columns are real columns: they appear in `InferModel`, in the migration IR
 * and in the generated DDL, exactly as if you had typed them.
 */

import {
  type Column,
  type ColumnFlags,
  type Model,
  type WhereInput,
  column,
  sql,
} from "./index.js";

/** Any class usable as a mixin base — `Model` itself, or another mixin's result. */
// biome-ignore lint/suspicious/noExplicitAny: a mixin base accepts any constructor shape.
export type ModelBase = abstract new (...args: any[]) => Model;

/**
 * Add `createdAt` / `updatedAt` to a model.
 *
 * Both default to the database's own clock (`sql.now()`), and `updatedAt` carries
 * `onUpdate(sql.now())`, so an `UPDATE` refreshes it without the call site
 * remembering to. Both are `NOT NULL` with a default, so neither shows up as
 * required in `InferInsert`.
 *
 * @param Base The class to extend (`Model`, or another mixin's result).
 * @returns A subclass carrying the two timestamp columns.
 */
export function withTimestamps<TBase extends ModelBase>(Base: TBase) {
  abstract class WithTimestamps extends Base {
    /** When the row was inserted. */
    createdAt = column.datetime().notNull().default(sql.now());
    /** When the row was last updated — refreshed by every `UPDATE`. */
    updatedAt = column.datetime().notNull().default(sql.now()).onUpdate(sql.now());
  }
  return WithTimestamps;
}

/**
 * Add `deletedAt` to a model, for non-destructive deletes.
 *
 * A row is alive while `deletedAt IS NULL`. **Filtering is the caller's job** —
 * the mixin only declares the column, so it composes with whatever query strategy
 * a table needs (a partial index, a repository default, a view). Use
 * {@link notDeleted} to spell the predicate.
 *
 * @param Base The class to extend.
 * @returns A subclass carrying the `deletedAt` column.
 */
export function withSoftDelete<TBase extends ModelBase>(Base: TBase) {
  abstract class WithSoftDelete extends Base {
    /** When the row was soft-deleted, or `null` while it is alive. */
    deletedAt = column.datetime();
  }
  return WithSoftDelete;
}

/**
 * The `where` fragment matching rows that are **not** soft-deleted.
 *
 * @typeParam Row - the row type being filtered.
 * @returns `{ deletedAt: { isNull: true } }`, typed for the row.
 */
export function notDeleted<Row>(): WhereInput<Row> {
  return { deletedAt: { isNull: true } } as WhereInput<Row>;
}

/**
 * The `where` fragment matching **only** soft-deleted rows.
 *
 * @typeParam Row - the row type being filtered.
 * @returns `{ deletedAt: { isNull: false } }`, typed for the row.
 */
export function onlyDeleted<Row>(): WhereInput<Row> {
  return { deletedAt: { isNull: false } } as WhereInput<Row>;
}

/**
 * Add `createdBy` / `updatedBy` to a model — *who* touched the row.
 *
 * The actor column defaults to `column.uuid()`, matching the SDK's user id. A
 * service whose users are keyed by something else passes a factory:
 * `withAudit(Model, () => column.integer())`. It must be a factory, not a column:
 * the two properties need two independent column instances.
 *
 * Both columns are nullable — a row created by a background job has no actor, and
 * forcing a sentinel value there is worse than a `NULL`.
 *
 * @param Base The class to extend.
 * @param actor Factory producing the actor column (default: `column.uuid()`).
 * @returns A subclass carrying the two actor columns.
 */
export function withAudit<TBase extends ModelBase, A = string>(
  Base: TBase,
  actor: () => Column<A, ColumnFlags> = () =>
    column.uuid() as unknown as Column<A, ColumnFlags>,
) {
  abstract class WithAudit extends Base {
    /** Who created the row, or `null` when nobody was attributed. */
    createdBy = actor();
    /** Who last updated the row, or `null`. */
    updatedBy = actor();
  }
  return WithAudit;
}
