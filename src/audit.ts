/**
 * tempest-db-js — an append-only audit trail.
 *
 * `withTimestamps` records *when* a row changed and `withAudit` records *who*
 * touched it last. Neither keeps the **history**: one entry per create, update
 * and delete, with the actor, the action and a before/after diff.
 *
 * The entries are written through the repository signals, so they land in the
 * **same transaction** as the change itself — an audit row can never reference a
 * change that was rolled back.
 */

import type { AsyncSession } from "./engine.js";
import {
  type InferInsert,
  type InferModel,
  Model,
  type ModelClass,
  column,
  columnsOf,
  encodeColumnValue,
  primaryKeyFilter,
  sql,
} from "./index.js";
import { BaseRepository } from "./repository.js";
import { type SignalPayload, onSignal } from "./signals.js";

/** What happened to the row. */
export type AuditAction = "insert" | "update" | "delete";

/** A before/after pair per changed column. */
export type AuditDiff = Record<string, readonly [unknown, unknown]>;

/**
 * Build the base class for a service's audit-log table.
 *
 * @param name The table to store entries in.
 * @returns A model base carrying the audit columns; extend it to add your own.
 *
 * @example
 * ```ts
 * class AuditLog extends auditLogModel("audit_log") {}
 * ```
 */
export function auditLogModel(name: string) {
  abstract class AuditBase extends Model {
    static override tablename = name;
    /** Monotonic id — also the order the changes happened in. */
    id = column.bigInteger().primaryKey();
    /** The audited table. */
    tableName = column.varchar(200).notNull();
    /** The audited row's primary key, as an object. */
    rowKey = column.json<Record<string, unknown>>().notNull();
    /** What happened. */
    action = column.enum("insert", "update", "delete").notNull();
    /** Who did it, when the caller could say. */
    actor = column.varchar(200);
    /** The changed columns as `[before, after]`; the whole row on insert/delete. */
    changes = column.json<AuditDiff>().notNull();
    /** When the entry was written. */
    at = column.datetime().notNull().default(sql.now());
  }
  return AuditBase;
}

/** How auditing is wired for one model. */
export interface AuditOptions<L extends ModelClass> {
  /** The audit-log model to write entries into. */
  readonly log: L;
  /**
   * Who is making the change.
   *
   * Called at write time, so it can read whatever request-scoped context the
   * service keeps. Return `null` for a change with no human behind it.
   */
  readonly actor?: () => string | null;
  /** Columns never worth recording (a password hash, a big blob). */
  readonly exclude?: readonly string[];
}

/**
 * The columns of a row, encoded for storage in the log's JSON column.
 *
 * @param model The audited model.
 * @param row The row.
 * @param exclude Columns to leave out.
 * @returns The row as JSON-safe values.
 */
export function snapshot(
  model: ModelClass,
  row: Record<string, unknown>,
  exclude: readonly string[] = [],
): Record<string, unknown> {
  const columns = columnsOf(model);
  const out: Record<string, unknown> = {};
  for (const [name, col] of Object.entries(columns)) {
    if (exclude.includes(name)) continue;
    if (!(name in row)) continue;
    out[name] = encodeColumnValue(col, row[name]);
  }
  return out;
}

/**
 * The columns that differ between two snapshots.
 *
 * Compared **after** encoding, so a `Date` and its stored string do not read as a
 * change; a column missing from one side counts as a change to `null`.
 *
 * @param before The earlier snapshot.
 * @param after The later snapshot.
 * @returns One `[before, after]` pair per changed column.
 */
export function diffSnapshots(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): AuditDiff {
  const diff: Record<string, readonly [unknown, unknown]> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) diff[key] = [from, to];
  }
  return diff;
}

/** Rows read before a write, per session, so the diff has a "before" side. */
const pending = new WeakMap<AsyncSession, Map<string, Record<string, unknown>>>();

/** Key a row within a session's pending map. */
function pendingKey(model: ModelClass, key: Record<string, unknown>): string {
  return `${model.tablename}:${JSON.stringify(key)}`;
}

/**
 * Record every create, update and delete of a model into an audit log.
 *
 * Wired through the repository signals, so entries are written on the same
 * session — and therefore inside the same transaction — as the change. A change
 * that rolls back takes its audit entry with it.
 *
 * @param model The model to audit.
 * @param options The log model, the actor resolver and any excluded columns.
 * @returns A function that turns auditing off again.
 *
 * @example
 * ```ts
 * class AuditLog extends auditLogModel("audit_log") {}
 * enableAudit(Order, { log: AuditLog, actor: () => currentUser()?.id ?? null });
 * ```
 */
export function enableAudit<C extends ModelClass, L extends ModelClass>(
  model: C,
  options: AuditOptions<L>,
): () => void {
  const exclude = options.exclude ?? [];

  /** Write one entry through the same session the change is on. */
  const write = async (
    session: AsyncSession,
    action: AuditAction,
    row: Record<string, unknown>,
    changes: AuditDiff,
  ): Promise<void> => {
    await new BaseRepository(options.log, session).create({
      tableName: model.tablename,
      rowKey: primaryKeyFilter(model, row),
      action,
      actor: options.actor?.() ?? null,
      changes,
    } as unknown as InferInsert<L>);
  };

  const offs = [
    onSignal(model, "preSave", async ({ row, session, isInsert }: SignalPayload<C>) => {
      if (isInsert) return;
      const key = primaryKeyFilter(model, row as Record<string, unknown>);
      const before = await new BaseRepository(model, session).first(key as never);
      if (!before) return;
      let bySession = pending.get(session);
      if (!bySession) {
        bySession = new Map();
        pending.set(session, bySession);
      }
      bySession.set(
        pendingKey(model, key),
        snapshot(model, before as Record<string, unknown>, exclude),
      );
    }),

    onSignal(model, "postSave", async ({ row, session, isInsert }: SignalPayload<C>) => {
      const record = row as Record<string, unknown>;
      const after = snapshot(model, record, exclude);
      if (isInsert) {
        await write(session, "insert", record, toInsertDiff(after));
        return;
      }
      const key = pendingKey(model, primaryKeyFilter(model, record));
      const before = pending.get(session)?.get(key) ?? {};
      pending.get(session)?.delete(key);
      const changes = diffSnapshots(before, after);
      if (Object.keys(changes).length === 0) return;
      await write(session, "update", record, changes);
    }),

    onSignal(model, "preDelete", async ({ row, session }: SignalPayload<C>) => {
      const record = row as Record<string, unknown>;
      await write(
        session,
        "delete",
        record,
        toDeleteDiff(snapshot(model, record, exclude)),
      );
    }),
  ];

  return () => {
    for (const off of offs) off();
  };
}

/** An insert has no "before": every column reads as `[null, value]`. */
function toInsertDiff(after: Record<string, unknown>): AuditDiff {
  const diff: Record<string, readonly [unknown, unknown]> = {};
  for (const [key, value] of Object.entries(after)) diff[key] = [null, value];
  return diff;
}

/** A delete has no "after": every column reads as `[value, null]`. */
function toDeleteDiff(before: Record<string, unknown>): AuditDiff {
  const diff: Record<string, readonly [unknown, unknown]> = {};
  for (const [key, value] of Object.entries(before)) diff[key] = [value, null];
  return diff;
}

/** The row type of an audit-log model, for the reader's convenience. */
export type AuditEntry<L extends ModelClass> = InferModel<L>;
