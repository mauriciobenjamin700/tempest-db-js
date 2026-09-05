/**
 * tempest-db-js — the transactional outbox.
 *
 * The dual-write problem: a handler that writes a row **and** publishes an event
 * cannot do both safely as two independent operations. Die after the commit and
 * the event is lost; die after the publish and a phantom event points at a row
 * that never existed.
 *
 * The fix is to write the business row and an `outbox` row in the **same
 * transaction** — either both commit or neither does — and let a separate relay
 * read pending rows and publish them. The broker can be down for minutes; the
 * events wait durably in the table.
 *
 * Atomicity here comes from `session.transaction()`, which is re-entrant: the
 * repository writes and the `publish()` run on the same session, inside one
 * block, so there is no second mechanism to learn.
 */

import type { AsyncSession } from "./engine.js";
import {
  type InferInsert,
  type InferModel,
  Model,
  type ModelClass,
  column,
  sql,
} from "./index.js";
import { update } from "./mutations.js";
import { select } from "./query.js";
// Imported from its own module, not from the barrel: `index.ts` re-exports this
// module too, and a class cannot extend a binding the barrel has not initialized
// yet.
import { BaseRepository } from "./repository.js";

/** Where an outbox row is in its lifecycle. */
export type OutboxStatus = "pending" | "sending" | "sent" | "failed";

/**
 * Build the base class for a service's outbox table.
 *
 * @param tablename The table to store events in.
 * @returns A model base carrying the outbox columns; extend it to add your own.
 *
 * @example
 * ```ts
 * class OutboxEvent extends outboxModel("outbox") {}
 * ```
 */
export function outboxModel(name: string) {
  abstract class OutboxBase extends Model {
    static override tablename = name;
    /** Monotonic id; also the claim order, so events publish in the order written. */
    id = column.bigInteger().primaryKey();
    /** The routing key the relay publishes under. */
    topic = column.varchar(200).notNull();
    /** The event body. */
    payload = column.json<Record<string, unknown>>().notNull();
    /** Lifecycle state. */
    status = column
      .enum("pending", "sending", "sent", "failed")
      .notNull()
      .default("pending");
    /** How many publish attempts have been made. */
    attempts = column.integer().notNull().default(0);
    /** Epoch milliseconds before which the row must not be claimed (backoff). */
    availableAt = column.bigInteger().notNull().default(0n);
    /** When the row was written. */
    createdAt = column.datetime().notNull().default(sql.now());
    /** When the relay confirmed the publish. */
    sentAt = column.datetime();
    /** The last failure's message, kept for triage. */
    lastError = column.text();
  }
  return OutboxBase;
}

/** An event to write to the outbox. */
export interface OutboxEventInput {
  /** The routing key. */
  readonly topic: string;
  /** The event body. */
  readonly payload: Record<string, unknown>;
  /** Delay the first attempt by this many milliseconds. */
  readonly delayMs?: number;
}

/** Options for {@link OutboxRepository.claim}. */
export interface ClaimOptions {
  /** Only claim events on these topics. */
  readonly topics?: readonly string[];
  /** Treat the clock as this instant (tests). */
  readonly now?: number;
}

/** Options for {@link OutboxRepository.markFailed}. */
export interface FailOptions {
  /** Wait this long before the row can be claimed again. */
  readonly retryInMs?: number;
  /** Give up permanently instead of scheduling a retry. */
  readonly permanent?: boolean;
}

/**
 * The relay's half of the outbox: claim, confirm, and fail with backoff.
 *
 * @typeParam C - the outbox model class.
 */
export class OutboxRepository<C extends ModelClass> extends BaseRepository<C> {
  /**
   * Write events to the outbox.
   *
   * Call it inside the same `transaction()` as the business write — that is the
   * whole point, and it is why this does not open a transaction of its own.
   *
   * @param events One event, or many.
   * @returns The stored rows.
   */
  async publish(
    events: OutboxEventInput | readonly OutboxEventInput[],
  ): Promise<InferModel<C>[]> {
    const list = Array.isArray(events) ? events : [events as OutboxEventInput];
    if (list.length === 0) return [];
    const now = Date.now();
    return this.createMany(
      list.map(
        (event) =>
          ({
            topic: event.topic,
            payload: event.payload,
            status: "pending",
            attempts: 0,
            availableAt: BigInt(now + (event.delayMs ?? 0)),
          }) as unknown as InferInsert<C>,
      ),
    );
  }

  /**
   * Claim a batch of due events for this relay, in one statement.
   *
   * Uses `FOR UPDATE SKIP LOCKED` over a subquery, so two relays running at once
   * take **disjoint** batches instead of fighting over the same rows. SQLite has
   * no row locking and throws — a single-process relay there can claim with
   * `pending()` plus an update.
   *
   * @param limit How many events to take.
   * @param options Topic filter, and a clock override for tests.
   * @returns The claimed rows, oldest first.
   */
  async claim(limit: number, options?: ClaimOptions): Promise<InferModel<C>[]> {
    const now = options?.now ?? Date.now();
    const due = this.dueQuery(now, options?.topics)
      .orderBy("id" as keyof InferModel<C> & string)
      .limit(limit)
      .forUpdate({ skipLocked: true })
      .asSubquery("id" as keyof InferModel<C> & string);

    return this.session
      .execute(
        update(this.model)
          .set({
            status: "sending",
            attempts: sql.raw("attempts + 1"),
          } as unknown as Partial<InferModel<C>>)
          .where({ id: { in: due } } as never)
          .returning(),
      )
      .all() as Promise<InferModel<C>[]>;
  }

  /**
   * The events that are due, without claiming them.
   *
   * @param limit How many to read.
   * @param options Topic filter and clock override.
   * @returns The due rows, oldest first.
   */
  async pending(limit: number, options?: ClaimOptions): Promise<InferModel<C>[]> {
    const now = options?.now ?? Date.now();
    return this.session
      .execute(
        this.dueQuery(now, options?.topics)
          .orderBy("id" as keyof InferModel<C> & string)
          .limit(limit),
      )
      .all() as Promise<InferModel<C>[]>;
  }

  /**
   * Confirm that events were published.
   *
   * @param ids The claimed ids.
   * @returns How many rows were marked sent.
   */
  async markSent(ids: readonly bigint[]): Promise<number> {
    if (ids.length === 0) return 0;
    return this.update(
      { id: { in: ids } } as never,
      {
        status: "sent",
        sentAt: sql.now(),
      } as unknown as Partial<InferModel<C>>,
    );
  }

  /**
   * Record a failed publish, scheduling a retry unless it is permanent.
   *
   * The attempt counter was already incremented by {@link claim}, so a row that
   * keeps failing carries its own history — which is what a dead-letter policy
   * reads.
   *
   * @param id The event's id.
   * @param error The failure, for triage.
   * @param options Backoff delay, or `permanent` to stop retrying.
   * @returns How many rows were updated (0 or 1).
   */
  async markFailed(id: bigint, error: unknown, options?: FailOptions): Promise<number> {
    const message = error instanceof Error ? error.message : String(error);
    return this.update(
      { id } as never,
      {
        status: options?.permanent ? "failed" : "pending",
        availableAt: BigInt(Date.now() + (options?.retryInMs ?? 0)),
        lastError: message.slice(0, 1000),
      } as unknown as Partial<InferModel<C>>,
    );
  }

  /**
   * The SELECT of events that may be claimed now.
   *
   * @param now The current epoch milliseconds.
   * @param topics Optional topic filter.
   * @returns The builder, unordered.
   */
  private dueQuery(now: number, topics?: readonly string[]) {
    const where: Record<string, unknown> = {
      status: "pending",
      availableAt: { lte: BigInt(now) },
    };
    if (topics && topics.length > 0) where.topic = { in: topics };
    return select(this.model).where(where as never);
  }
}
