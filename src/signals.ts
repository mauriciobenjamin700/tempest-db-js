/**
 * tempest-db-js — lifecycle signals around the repository's write path.
 *
 * Reacting to persistence — busting a cache, enqueuing an outbox event, syncing a
 * search index, writing an audit row — otherwise means wrapping every call site
 * by hand, and the one call site somebody forgets is the bug.
 *
 * Handlers run **inside** whatever transaction is open, because they are handed
 * the same session the write used: a handler that writes commits with the write,
 * or rolls back with it.
 */

import type { AsyncSession } from "./engine.js";
import type { InferModel, ModelClass } from "./index.js";

/** The points a repository write is observable at. */
export type RepositorySignal = "preSave" | "postSave" | "preDelete" | "postDelete";

/** What a handler receives. */
export interface SignalPayload<C extends ModelClass> {
  /**
   * The row the signal is about.
   *
   * `preSave` on an insert carries what was passed to `create`, so a
   * database-generated id is not there yet — `postSave` carries the stored row.
   * `preDelete` carries the row as it was just before it was deleted.
   */
  readonly row: InferModel<C>;
  /** The model being written. */
  readonly model: C;
  /** The session the write is running on — the same transaction, if one is open. */
  readonly session: AsyncSession;
  /** True when the write that fired this was an insert rather than an update. */
  readonly isInsert: boolean;
}

/** A signal handler; may be async, and is awaited. */
export type SignalHandler<C extends ModelClass> = (
  payload: SignalPayload<C>,
) => void | Promise<void>;

/* biome-ignore lint/suspicious/noExplicitAny: the registry mixes models. */
type AnyHandler = SignalHandler<any>;

/** Handlers per model, per signal. Keyed weakly so a model class can be collected. */
const registry = new WeakMap<ModelClass, Map<RepositorySignal, Set<AnyHandler>>>();

/** Models that have ever had a handler, so `clearSignals()` can reach them all. */
const registered = new Set<ModelClass>();

/**
 * Register a handler for one signal on one model.
 *
 * @param model The model to observe.
 * @param signal Which point to observe.
 * @param handler The handler; awaited, and free to use the payload's session.
 * @returns A function that unregisters this handler.
 *
 * @example
 * ```ts
 * const off = onSignal(User, "postSave", async ({ row }) => {
 *   await cache.del(`user:${row.id}`);
 * });
 * ```
 */
export function onSignal<C extends ModelClass>(
  model: C,
  signal: RepositorySignal,
  handler: SignalHandler<C>,
): () => void {
  let bySignal = registry.get(model);
  if (!bySignal) {
    bySignal = new Map();
    registry.set(model, bySignal);
    registered.add(model);
  }
  let handlers = bySignal.get(signal);
  if (!handlers) {
    handlers = new Set();
    bySignal.set(signal, handlers);
  }
  handlers.add(handler as AnyHandler);
  return () => {
    handlers?.delete(handler as AnyHandler);
  };
}

/**
 * Whether anything is listening to a signal on a model.
 *
 * The repository asks before doing work only a handler would need — reading the
 * rows a filter-based `update`/`delete` is about to touch costs a `SELECT`, and
 * nobody should pay it when no handler exists.
 *
 * @param model The model.
 * @param signal The signal.
 * @returns True when at least one handler is registered.
 */
export function hasHandlers(model: ModelClass, signal: RepositorySignal): boolean {
  return (registry.get(model)?.get(signal)?.size ?? 0) > 0;
}

/**
 * Fire a signal, awaiting every handler in registration order.
 *
 * A handler that throws **propagates**: on `preSave`/`preDelete` that vetoes the
 * write, which is the point — a veto that could be swallowed would be a
 * suggestion.
 *
 * @param signal The signal to fire.
 * @param payload What to hand the handlers.
 */
export async function emitSignal<C extends ModelClass>(
  signal: RepositorySignal,
  payload: SignalPayload<C>,
): Promise<void> {
  const handlers = registry.get(payload.model)?.get(signal);
  if (!handlers || handlers.size === 0) return;
  for (const handler of [...handlers]) {
    await handler(payload);
  }
}

/**
 * Drop registered handlers — for tests, which otherwise leak them across cases.
 *
 * @param model Only this model's handlers; omitted, every model's.
 */
export function clearSignals(model?: ModelClass): void {
  if (model) {
    registry.delete(model);
    registered.delete(model);
    return;
  }
  for (const registeredModel of registered) registry.delete(registeredModel);
  registered.clear();
}
