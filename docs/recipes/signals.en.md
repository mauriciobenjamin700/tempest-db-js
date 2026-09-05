# Repository signals

React to persistence — bust a cache, enqueue an event, sync a search index, write an
audit row — without wrapping **every** call site by hand. The one call site somebody
forgets is the bug.

```ts
import { onSignal } from "tempest-db-js";

onSignal(User, "postSave", async ({ row, session }) => {
  await cache.del(`user:${row.id}`);
});
```

## The four points

| Signal | When | What `row` carries |
| --- | --- | --- |
| `preSave` | before the INSERT/UPDATE | what you passed (insert) or the row with the patch applied (update) |
| `postSave` | after | the **stored** row — generated id included |
| `preDelete` | before the DELETE | the row as it was; the last chance to see it |
| `postDelete` | after | the same pre-image |

They fire on `BaseRepository`'s `create`, `createMany`, `update` and `delete` — **per
row**, even in a batch.

## Vetoing a write

```ts
onSignal(Order, "preSave", ({ row }) => {
  if (row.total < 0) throw new ValidationError("negative total");
});
```

A handler that throws on `preSave`/`preDelete` **stops the write**: the error reaches the
caller. It is not a suggestion — a veto that could be swallowed would not be a veto.

## Handlers run inside your transaction

The payload carries the **same** session the write used, so a handler that writes commits
with it:

```ts
onSignal(Order, "postSave", async ({ row, session }) => {
  await new BaseRepository(OutboxEvent, session).create({ topic: "order.created", ... });
});

await session.transaction(async () => {
  await orders.create(order);   // row and event, or neither
});
```

!!! info "No handler, no cost"

    `update`/`delete` take a **filter**, not a row — handing the row to a handler means
    reading it first. That extra `SELECT` only happens when a handler is registered
    (`hasHandlers`), so code that does not use signals pays nothing.

!!! warning "`activeRecord` does not fire them"

    Signals live on `BaseRepository`'s path. `activeRecord` writes through the builders
    directly and does **not** fire them — if you mix the two, route the observable writes
    through the repository.

!!! tip "Clear between tests"

    A registered handler is global and lives until the process exits. `clearSignals()`
    (or `clearSignals(Model)`) in an `afterEach` keeps one test from seeing another's
    handler.

## Recap

- `onSignal(Model, signal, handler)` returns the function that unregisters it.
- `preSave`/`preDelete` throwing **vetoes** the write.
- The handler gets the write's session, so it joins the transaction.
- `hasHandlers` is what keeps the cost at zero for everyone else. 🚀
