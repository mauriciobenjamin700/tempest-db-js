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

## Recap

- `engine.transaction(fn)` → `COMMIT` on success, `ROLLBACK` if `fn` throws.
- Let the error **propagate** to abort — swallowing the error causes an unwanted commit.
- `tx.beginNested(fn)` → savepoint; rolls back only the sub-transaction.
- Works for async (`createEngine`) and sync (`createSyncEngine`).
