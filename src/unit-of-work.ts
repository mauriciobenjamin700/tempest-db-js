/**
 * tempest-db-js — an opt-in unit of work with an identity map.
 *
 * The default stays what it has always been: a row is a plain object, and a write
 * happens when you ask for it. This adds the other model, for the code that wants
 * it — load a row once, mutate it, and let one `flush()` work out the statements.
 *
 * Two things it buys, both of which the plain path cannot:
 *
 * - **Identity.** Loading the same row twice returns the **same object**, so two
 *   references cannot drift apart in memory while both believe they are the row.
 * - **Batching.** Ten mutations become the statements the changes actually
 *   require, in one transaction, instead of ten round trips.
 */

import type { AsyncSession } from "./engine.js";
import {
  type InferInsert,
  type InferModel,
  type ModelClass,
  type WhereInput,
  columnsOf,
  primaryKeyFilter,
} from "./index.js";
import { BaseRepository } from "./repository.js";

/** Phantom brand distinguishing a tracked row from a plain one. */
declare const TRACKED: unique symbol;

/**
 * A row the unit of work is watching.
 *
 * The brand is what makes "tracked" visible in the type: a function taking a
 * `Tracked<Row>` cannot be handed a plain object that nothing will ever flush.
 */
export type Tracked<Row> = Row & { readonly [TRACKED]?: true };

/** What a flush did. */
export interface FlushResult {
  /** Rows inserted. */
  readonly inserted: number;
  /** Rows updated. */
  readonly updated: number;
  /** Rows deleted. */
  readonly deleted: number;
}

/** One row being tracked, with the snapshot the diff is taken against. */
interface Entry {
  readonly model: ModelClass;
  readonly row: Record<string, unknown>;
  /** The values as loaded; `null` for a row that does not exist yet. */
  snapshot: Record<string, unknown> | null;
  state: "clean" | "new" | "removed";
}

/**
 * An identity map plus a change log, flushed as one transaction.
 *
 * Scope it explicitly — one per request, one per job — and flush it before it
 * goes away. Nothing here is global.
 */
export class UnitOfWork {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly session: AsyncSession) {}

  /** How many rows are being tracked. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Load a row by primary key, or return the one already loaded.
   *
   * The second call for the same key does **not** hit the database and returns
   * the **same object** as the first.
   *
   * @param model The model class.
   * @param key The primary key — a value, or an object for a composite key.
   * @returns The tracked row, or `null` when there is none.
   */
  async get<C extends ModelClass>(
    model: C,
    key: unknown,
  ): Promise<Tracked<InferModel<C>> | null> {
    const id = this.identity(model, key);
    const known = this.entries.get(id);
    if (known)
      return known.state === "removed" ? null : (known.row as Tracked<InferModel<C>>);

    const row = await new BaseRepository(model, this.session).getByIdOrNull(key);
    if (row === null) return null;
    const tracked = { ...(row as Record<string, unknown>) };
    this.entries.set(id, {
      model,
      row: tracked,
      snapshot: { ...tracked },
      state: "clean",
    });
    return tracked as Tracked<InferModel<C>>;
  }

  /**
   * Track an existing row that was loaded elsewhere.
   *
   * @param model The model class.
   * @param row The row, as loaded.
   * @returns The tracked object — the same one, if this row is already known.
   */
  track<C extends ModelClass>(model: C, row: InferModel<C>): Tracked<InferModel<C>> {
    const id = this.identity(model, row);
    const known = this.entries.get(id);
    if (known) return known.row as Tracked<InferModel<C>>;
    const tracked = { ...(row as Record<string, unknown>) };
    this.entries.set(id, {
      model,
      row: tracked,
      snapshot: { ...tracked },
      state: "clean",
    });
    return tracked as Tracked<InferModel<C>>;
  }

  /**
   * Schedule an insert.
   *
   * @param model The model class.
   * @param data The row to insert; it must carry the primary key, since the
   *   identity map is keyed by it and a database-generated id is not known yet.
   * @returns The tracked row.
   * @throws Error When the key is incomplete.
   */
  add<C extends ModelClass>(model: C, data: InferInsert<C>): Tracked<InferModel<C>> {
    const row = { ...(data as Record<string, unknown>) };
    const id = this.identity(model, row);
    this.entries.set(id, { model, row, snapshot: null, state: "new" });
    return row as Tracked<InferModel<C>>;
  }

  /**
   * Schedule a delete.
   *
   * A row added and then removed before the flush simply disappears — no
   * statement is emitted for it.
   *
   * @param model The model class.
   * @param row The row to delete.
   */
  remove<C extends ModelClass>(model: C, row: InferModel<C>): void {
    const id = this.identity(model, row);
    const known = this.entries.get(id);
    if (known?.state === "new") {
      this.entries.delete(id);
      return;
    }
    if (known) {
      known.state = "removed";
      return;
    }
    this.entries.set(id, {
      model,
      row: { ...(row as Record<string, unknown>) },
      snapshot: { ...(row as Record<string, unknown>) },
      state: "removed",
    });
  }

  /**
   * Write every pending change, in one transaction.
   *
   * Order is inserts, then updates, then deletes — the order that keeps a
   * foreign key satisfied when a new parent and its children are flushed
   * together. It is **not** a topological sort: a graph that needs one should be
   * flushed in stages.
   *
   * A statement that fails takes the whole flush with it, since it all runs in
   * one transaction. The tracked state is left untouched in that case, so the
   * caller can fix and flush again.
   *
   * @returns How many rows were inserted, updated and deleted.
   */
  async flush(): Promise<FlushResult> {
    const inserts = [...this.entries.values()].filter((e) => e.state === "new");
    const removals = [...this.entries.values()].filter((e) => e.state === "removed");
    const updates = [...this.entries.values()]
      .filter((e) => e.state === "clean" && e.snapshot !== null)
      .map((entry) => ({ entry, patch: diffRow(entry) }))
      .filter(({ patch }) => Object.keys(patch).length > 0);

    if (inserts.length === 0 && updates.length === 0 && removals.length === 0) {
      return { inserted: 0, updated: 0, deleted: 0 };
    }

    const result = await this.session.transaction(async (tx) => {
      let inserted = 0;
      let updated = 0;
      let deleted = 0;
      for (const entry of inserts) {
        await new BaseRepository(entry.model, tx).create(
          entry.row as InferInsert<ModelClass>,
        );
        inserted += 1;
      }
      for (const { entry, patch } of updates) {
        updated += await new BaseRepository(entry.model, tx).update(
          primaryKeyFilter(entry.model, entry.row) as WhereInput<InferModel<ModelClass>>,
          patch as Partial<InferModel<ModelClass>>,
        );
      }
      for (const entry of removals) {
        deleted += await new BaseRepository(entry.model, tx).delete(
          primaryKeyFilter(entry.model, entry.row) as WhereInput<InferModel<ModelClass>>,
        );
      }
      return { inserted, updated, deleted };
    });

    for (const entry of inserts) entry.state = "clean";
    for (const { entry } of updates) entry.snapshot = { ...entry.row };
    for (const entry of inserts) entry.snapshot = { ...entry.row };
    for (const entry of removals) {
      this.entries.delete(this.identity(entry.model, entry.row));
    }
    return result;
  }

  /** Forget everything tracked, without writing. */
  clear(): void {
    this.entries.clear();
  }

  /**
   * The identity-map key for a row or a primary key.
   *
   * @param model The model class.
   * @param key The row, or the key.
   * @returns A stable string key.
   */
  private identity(model: ModelClass, key: unknown): string {
    return `${model.tablename}:${JSON.stringify(primaryKeyFilter(model, key))}`;
  }
}

/**
 * The columns of a tracked row that differ from its snapshot.
 *
 * Only real columns are compared, so a property somebody hung on the object does
 * not turn into a write.
 *
 * @param entry The tracked entry.
 * @returns The patch to write, empty when nothing changed.
 */
function diffRow(entry: Entry): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const snapshot = entry.snapshot ?? {};
  for (const name of Object.keys(columnsOf(entry.model))) {
    if (!(name in entry.row)) continue;
    const before = snapshot[name] ?? null;
    const after = entry.row[name] ?? null;
    if (!sameValue(before, after)) patch[name] = entry.row[name];
  }
  return patch;
}

/**
 * Compare two column values for the diff.
 *
 * `Date` and `Uint8Array` are compared by content: two objects holding the same
 * instant are not a change, and reference equality would report one on every
 * flush.
 *
 * @param a The snapshot's value.
 * @param b The current value.
 * @returns True when they are the same value.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}
