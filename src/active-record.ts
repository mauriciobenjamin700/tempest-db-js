/**
 * tempest-db-js — opt-in active-record layer.
 *
 * The library's default return shape is a plain inferred object (a locked design
 * decision — see the roadmap). This module adds an **opt-in** wrapper for code
 * that prefers instance methods: `ActiveRecord` holds the plain row on `.data`
 * and exposes `save` / `update` / `delete` / `reload` over an async session. It
 * never replaces the default plain-object return — you reach for it explicitly.
 */

import type { AsyncSession } from "./engine.js";
import {
  type InferInsert,
  type InferModel,
  type ModelClass,
  columnsOf,
} from "./index.js";
import { insert } from "./mutations.js";
import { del, update } from "./mutations.js";
import { type WhereInput, select } from "./query.js";

/** Find the single primary-key column name of a model. */
function primaryKeyOf(model: ModelClass): string {
  for (const [name, col] of Object.entries(columnsOf(model))) {
    if (col.flags.primaryKey) return name;
  }
  throw new Error(`${model.tablename} has no primary key`);
}

/**
 * An opt-in active-record wrapper around a single row.
 *
 * The current field values live on {@link data} (a plain, typed row object).
 * Mutating methods persist through the bound session and refresh `data`.
 *
 * @typeParam C - the model class.
 */
export class ActiveRecord<C extends ModelClass> {
  private readonly pk: string;

  constructor(
    private readonly model: C,
    private readonly session: AsyncSession,
    /** The current field values (a plain, typed row). */
    public data: InferModel<C>,
  ) {
    this.pk = primaryKeyOf(model);
  }

  /** The primary-key value of the wrapped row. */
  private pkValue(): unknown {
    return (this.data as Record<string, unknown>)[this.pk];
  }

  private pkFilter(): WhereInput<InferModel<C>> {
    return { [this.pk]: this.pkValue() } as WhereInput<InferModel<C>>;
  }

  /**
   * Persist the current `data` — insert if new, otherwise overwrite the existing
   * row (upsert on the primary key). Refreshes `data` from the returned row.
   *
   * @returns This wrapper, for chaining.
   */
  async save(): Promise<this> {
    // Overwrite only the columns actually present in `data` (an absent column
    // would otherwise be set to null and could violate NOT NULL / clobber a
    // DB-side default).
    const cols = columnsOf(this.model);
    const rowData = this.data as Record<string, unknown>;
    const setPatch: Record<string, unknown> = {};
    for (const c of Object.keys(rowData)) {
      if (c !== this.pk && c in cols) setPatch[c] = rowData[c];
    }
    const saved = await this.session
      .execute(
        insert(this.model)
          .values(this.data as InferInsert<C>)
          .onConflictDoUpdate(
            [this.pk] as (keyof InferModel<C> & string)[],
            setPatch as Partial<InferModel<C>>,
          )
          .returning(),
      )
      .one();
    this.data = saved as InferModel<C>;
    return this;
  }

  /**
   * Update the given columns for this row and merge them into `data`.
   *
   * @param patch The columns to change.
   * @returns This wrapper, for chaining.
   */
  async update(patch: Partial<InferModel<C>>): Promise<this> {
    await this.session.execute(update(this.model).set(patch).where(this.pkFilter()));
    this.data = { ...this.data, ...patch };
    return this;
  }

  /**
   * Delete this row.
   *
   * @returns The number of rows affected (0 or 1).
   */
  async delete(): Promise<number> {
    return this.session.execute(del(this.model).where(this.pkFilter())).rowsAffected();
  }

  /**
   * Re-fetch this row by primary key and refresh `data`.
   *
   * @returns This wrapper, for chaining.
   * @throws When the row no longer exists.
   */
  async reload(): Promise<this> {
    const fresh = await this.session
      .execute(select(this.model).where(this.pkFilter()))
      .first();
    if (fresh === null) {
      throw new Error(
        `${this.model.tablename} row ${JSON.stringify(this.pkValue())} not found on reload`,
      );
    }
    this.data = fresh as InferModel<C>;
    return this;
  }
}

/** A small factory binding a model + session for producing {@link ActiveRecord}s. */
export interface ActiveRecordManager<C extends ModelClass> {
  /** Wrap an existing row (already loaded) as an active record. */
  wrap(row: InferModel<C>): ActiveRecord<C>;
  /** Build an unsaved active record from insert data; call `.save()` to persist. */
  create(data: InferInsert<C>): ActiveRecord<C>;
  /** Fetch a row by primary key and wrap it, or `null` if absent. */
  get(id: unknown): Promise<ActiveRecord<C> | null>;
}

/**
 * Create an {@link ActiveRecordManager} for a model over a session.
 *
 * @param model The model class.
 * @param session The async session to persist through.
 * @returns A manager that wraps/fetches rows as active records.
 *
 * @example
 * ```ts
 * const users = activeRecord(User, engine.session());
 * const u = users.create({ name: "Ana", age: 30 });
 * await u.save();
 * await u.update({ age: 31 });
 * await u.delete();
 * ```
 */
export function activeRecord<C extends ModelClass>(
  model: C,
  session: AsyncSession,
): ActiveRecordManager<C> {
  const pk = primaryKeyOf(model);
  return {
    wrap: (row) => new ActiveRecord(model, session, row),
    create: (data) => new ActiveRecord(model, session, data as unknown as InferModel<C>),
    async get(id) {
      const row = await session
        .execute(select(model).where({ [pk]: id } as WhereInput<InferModel<C>>))
        .first();
      return row === null ? null : new ActiveRecord(model, session, row as InferModel<C>);
    },
  };
}
