# Running queries

So far we've built queries as a **typed AST**, without touching a database. Now
let's **really execute** them: create an engine from a URL, open a session, and
run the queries.

!!! info "Async by default, sync optional"

    tempest-db-js is **async-first**: `createEngine` returns an async engine, which
    works for SQLite and PostgreSQL. For SQLite there's also `createSyncEngine`
    (synchronous) — great for scripts, seeds, and tests. PostgreSQL is async-only
    (there's no serious sync driver in Node).

## Step 1 — Create the engine from the URL

The database is identified by its **URL** — switching databases means switching
the string:

```ts
import { createEngine, createSyncEngine } from "tempest-db-js";

const engine = createEngine("postgresql://app:app@localhost/app"); // async
const sqlite = createEngine("sqlite:///app.db");                    // async, SQLite
const sync   = createSyncEngine("sqlite://:memory:");               // sync, SQLite
```

!!! tip "Drivers"

    SQLite uses Node's built-in `node:sqlite` by default (zero install).
    PostgreSQL uses `postgres.js` (install `postgres`). They are optional peer
    deps — install only what you use.

## Step 2 — Open a session and execute

`session.execute(query)` compiles the query for the right dialect, runs it, and
**coerces** the rows back to native types (bigint, `Date`, boolean, JSON):

=== "Async (default)"

    ```ts
    const session = engine.session();

    const adults = await session.execute(
      select(User).where({ age: { gte: 18 } }),
    ).all(); // UserRow[]

    const user = await session.execute(
      select(User).where({ id: 1 }),
    ).first(); // UserRow | null

    await session.close();
    ```

=== "Sync (SQLite)"

    ```ts
    const session = sync.session();

    const adults = session.execute(
      select(User).where({ age: { gte: 18 } }),
    ).all(); // UserRow[] — no await

    session.close();
    ```

### Result terminals

| Terminal | Returns | Note |
| --- | --- | --- |
| `.all()` | `Row[]` | all rows |
| `.first()` | `Row \| null` | the first one, or `null` |
| `.one()` | `Row` | error (`NoResultError`) if ≠ 1 |
| `.oneOrNull()` | `Row \| null` | error if > 1 |
| `.scalar()` | value of the 1st column `\| null` | handy with a 1-column projection |
| `.scalars()` | values of the 1st column `[]` | — |
| `.rowsAffected()` | `number` | for INSERT/UPDATE/DELETE without `returning` |

The type already comes from the builder — `session.execute(select(User)).all()` is
`UserRow[]` without any annotation.

## Step 3 — The mutation guard at execution

Remember the typed guard on `update`/`del`? It holds **at the execution edge**:
`execute` only accepts an `update`/`del` that's already guarded (with `.where()` or
`.unguarded()`):

```ts
session.execute(update(User).set({ age: 31 }).where({ id: 1 })); // ✅
// session.execute(update(User).set({ age: 0 }));  // ❌ compile error
```

## Step 4 — Transactions

The recommended path: a transactional block that **commits on success** and
**rolls back on exception**:

```ts
await engine.transaction(async (tx) => {
  await tx.execute(insert(Order).values({ userId: 1, amount: 100, status: "paid" }));
  await tx.execute(update(User).set({ orders: 1 }).where({ id: 1 }));
  // automatic commit; if anything throws → automatic rollback
});
```

Savepoints (nested transaction) with `beginNested`:

```ts
engine.transaction((tx) => {
  tx.execute(insert(User).values(a));
  try {
    tx.beginNested((sp) => {
      sp.execute(insert(User).values(b)); // if it fails, only this savepoint reverts
    });
  } catch {
    // the outer transaction stays alive
  }
});
```

!!! check "All tested against a real database"

    tempest-db-js's SQLite execution is exercised in tests against a real database
    (`node:sqlite`), including type coercion, `RETURNING`, and transaction
    rollback. It's not a mock.

## Step 5 — Streaming large result sets

To avoid materializing everything in memory, `session.stream(query)` iterates row by
row — sync (SQLite) or async (`for await`):

```ts
// sync
for (const user of sync.session().stream(select(User))) {
  process(user);
}

// async
for await (const user of engine.session().stream(select(User))) {
  await process(user);
}
```

!!! tip "Pool (PostgreSQL)"

    `createEngine(url, { pool: { size: 10, idleTimeoutMs: 30000 } })` tunes the
    `postgres.js` pool. On SQLite the pool is ignored (single connection).

## Recap

- `createEngine(url)` (async) / `createSyncEngine(url)` (SQLite sync) — database by URL.
- `session.execute(query)` infers the return and coerces types.
- Terminals: `.all/.first/.one/.oneOrNull/.scalar/.scalars/.rowsAffected`.
- Mutation guard applied at `execute`.
- `engine.transaction(fn)` (automatic commit/rollback) + `beginNested` (savepoints).

To query several tables at once, let's go to **[Joins](joins.md)**. 👉
