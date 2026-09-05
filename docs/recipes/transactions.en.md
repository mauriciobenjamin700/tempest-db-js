# Transactions and savepoints

**Problem:** some operations only make sense **together** — debiting one account and
crediting another, creating an order and decrementing stock. If the second one fails, the
first **cannot** be left standing.

**Solution:** `engine.transaction(fn)` runs your block inside a transaction: **commit** if
everything succeeds, automatic **rollback** if anything throws. For a partial rollback,
there's `beginNested` (savepoints).

## The theory in one sentence

`transaction(fn)` does `BEGIN`, runs `fn`, and then `COMMIT` — but if `fn` throws, it does
`ROLLBACK` and re-throws the error. You never have to remember to close the transaction by
hand.

## All or nothing

```ts
import { createEngine, insert, update } from "tempest-db-js";

const engine = createEngine("sqlite:///bank.db");

await engine.transaction(async (tx) => {
  await tx.execute(update(Account).set({ balance: 90 }).where({ id: 1 }));
  await tx.execute(update(Account).set({ balance: 110 }).where({ id: 2 }));
  // reached here without throwing → automatic COMMIT
});
```

If the second line throws (insufficient balance, constraint violation, etc.), the
**first one is undone** — both accounts return to their previous state.

!!! danger "Don't silently swallow the error inside the block"

    The rollback is triggered by the **exception propagating out** of `fn`. If you
    `try/catch` everything in there and swallow the error, `transaction` thinks it
    succeeded and does a **commit**. Let the error bubble up (or re-throw it) when you
    want to abort.

## Savepoints: partial rollback

`beginNested` creates a **savepoint** — a sub-transaction that can roll back on its own
without taking down the outer transaction. Useful for "try this; if it fails, carry on
without it":

```ts
await engine.transaction(async (tx) => {
  await tx.execute(insert(Order).values({ userId: 1, total: "100.00" }));

  try {
    await tx.beginNested(async (sp) => {
      await sp.execute(insert(Coupon).values({ orderId: 1, code: "INVALID" }));
      // if this violates a constraint, only THIS savepoint rolls back
    });
  } catch {
    // the coupon failed, but the order is still standing — we carry on without a discount
  }

  await tx.execute(update(Order).set({ status: "confirmed" }).where({ id: 1 }));
  // COMMIT: order created + confirmed; coupon discarded
});
```

!!! info "Sync has transactions too"

    On synchronous SQLite (`createSyncEngine`), `engine.transaction((tx) => { ... })`
    works the same way — without `await`. Great for seeds and scripts.

    ```ts
    sync.transaction((tx) => {
      tx.execute(insert(User).values({ name: "seed", age: 1, nickname: null }));
    });
    ```

## Nested blocks: a single COMMIT

`transaction()` is **re-entrant**. A block opened inside another one, on the same
session, joins the outer one: one `BEGIN`, one `COMMIT`, and an inner failure takes the
whole thing down.

```ts
const session = engine.session();
const orders = new BaseRepository(Order, session);
const items = new BaseRepository(Item, session);

await session.transaction(async () => {
  await orders.create({ id: 1, total: 10 });   // no COMMIT here
  await items.createMany(lines);               // nor here
});                                            // one COMMIT at the end
```

That is what makes a service orchestrating several repositories work: they all hold the
**same session**, so they all see the same open block. Without re-entrancy, the second
`transaction()` would issue a `BEGIN` inside another one.

```ts
session.transactionDepth;   // 0 outside, 1 in the block, 2 when nested
session.inTransaction;      // boolean
```

!!! danger "Nested is not recoverable — a savepoint is"

    A failure in a nested block **takes the whole block down**, including the outer
    work. To recover from an inner failure without discarding the rest, use
    `beginNested`, which is a real `SAVEPOINT`:

    ```ts
    await session.transaction(async (tx) => {
      await orders.create(order);                       // survives
      await tx.beginNested(async (sp) => {
        await risky(sp);                                // only this rolls back
      }).catch(logAndContinue);
      await audit.create(entry);                        // keeps running
    });
    ```

    `beginNested` needs an open block — PostgreSQL rejects a savepoint outside a
    transaction.

## Isolation level

The level is requested on the block, not on the engine:

```ts
await session.transaction(
  async (tx) => {
    await claimBatch(tx);
  },
  { isolation: "serializable" },
);
```

| Level | PostgreSQL | SQLite | MySQL |
| --- | --- | --- | --- |
| `read uncommitted` | accepted (behaves as `read committed`) | **error** | accepted |
| `read committed` | default | **error** | accepted |
| `repeatable read` | accepted | **error** | default |
| `serializable` | accepted | the only one it has | accepted |

SQLite runs one writer at a time, so the only level it has **is** serializable — there
is no syntax to ask for another and no weaker level to fall back to. Asking for one
**throws**, because a caller who wrote `repeatable read` was reasoning about a
guarantee.

### Read-only blocks

```ts
await session.transaction(async (tx) => report(tx), { readOnly: true });
```

`BEGIN ... READ ONLY` on PostgreSQL, `START TRANSACTION READ ONLY` on MySQL: the
**database** refuses the write, not the application. SQLite throws — `PRAGMA query_only`
is per connection, not per transaction.

!!! danger "Serializable returns errors, and the error is normal"

    Under `serializable` PostgreSQL aborts one of two concurrent transactions with
    `could not serialize access` (SQLSTATE `40001`). That is not a bug: it is the
    database saying the pair would violate serializability. **The caller must retry** —
    without a retry, `serializable` only trades wrong data for an error.

!!! warning "Characteristics belong to the outermost block"

    Isolation is fixed when the transaction opens. Requesting it on a nested block
    (which joins the outer one) throws, rather than pretending it was applied.

## Recap

- `engine.transaction(fn)` → `COMMIT` on success, `ROLLBACK` if `fn` throws.
- Let the error **propagate** to abort — swallowing the error causes an unwanted commit.
- `tx.beginNested(fn)` → savepoint; rolls back only the sub-transaction.
- Works for async (`createEngine`) and sync (`createSyncEngine`).
