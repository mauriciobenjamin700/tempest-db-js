# Choosing the SQLite driver

tempest-db-js runs SQLite on **two** drivers. Node's built-in one is the default
and needs no install; `better-sqlite3` is one option away when you need what it
exposes.

| Driver | Install | When to use |
| --- | --- | --- |
| `node:sqlite` (default) | nothing — ships with Node ≥ 20 | The normal case |
| `better-sqlite3` | `npm install better-sqlite3` | `pragma()`, loadable extensions, or the driver the rest of your service already uses |

## The default: nothing to do

Say nothing and you run on `node:sqlite`:

```ts
import { Model, column, createSyncEngine, insert, select } from "tempest-db-js";

class Note extends Model {
  static override tablename = "notes";
  id = column.integer().primaryKey();
  title = column.varchar(80).notNull();
}

using engine = createSyncEngine("sqlite:///app.db");
const session = engine.session();

session.execute(insert(Note).values({ id: 1, title: "hello" }));
console.log(session.execute(select(Note)).all());
// [ { id: 1, title: "hello" } ]
```

## Switching to better-sqlite3

Install the package and name the driver. Two ways, same effect:

=== "Engine option"

    ```ts hl_lines="4"
    import { createSyncEngine } from "tempest-db-js";

    using engine = createSyncEngine("sqlite:///app.db", {
      driver: "better-sqlite3",
    });
    ```

=== "URL suffix"

    ```ts hl_lines="3"
    import { createSyncEngine } from "tempest-db-js";

    using engine = createSyncEngine("sqlite+better-sqlite3:///app.db");
    ```

The engine option wins over the suffix when both appear — so a URL coming from
the environment can be overridden in a test without rewriting the string.

Your models, queries and returned rows are **identical** on both drivers: the
same `bigint`, `Date`, `boolean` and JSON coercion, the same `RETURNING`, the
same `stream()`. Swapping drivers does not change your code.

!!! info "Both are synchronous"

    Either one serves `createSyncEngine` and `createEngine` alike — the async
    engine wraps the sync driver. SQLite has no truly async driver in Node; the
    difference is the API shape you write, not I/O.

## Driver options

`driverOptions` goes straight to the chosen driver's constructor, so each one
takes whatever its own documentation documents:

```ts
using reader = createSyncEngine("sqlite:///app.db", {
  driver: "better-sqlite3",
  driverOptions: { readonly: true },   // (1)!
});
```

1. A `better-sqlite3` option. On `node:sqlite` the same idea is spelled
   `{ readOnly: true }` — different names, because it is the driver's API, not ours.

## Connection pragmas

A SQLite pragma is **per connection**, not per file — so it belongs to the engine,
not to a migration. Only one has a default that changes behavior:

```ts
using engine = createSyncEngine("sqlite:///app.db", {
  sqlite: {
    foreignKeys: true,      // (1)!
    journalMode: "wal",     // (2)!
    busyTimeoutMs: 5000,    // (3)!
    synchronous: "normal",  // (4)!
  },
});
```

1. **Defaults to `true`.** Turned on by us, not by SQLite.
2. Readers stop blocking the writer. Needs a real file.
3. How long a writer waits on a lock before giving up.
4. Durability vs write throughput.

!!! danger "Without `foreign_keys = ON`, your FK is decorative"

    SQLite ships with foreign-key enforcement **off**, per connection. Without turning
    it on, an orphan `INSERT` is accepted and `ON DELETE CASCADE` never fires — the
    constraint is in the schema and does nothing.

    tempest-db-js turns it on by default, so the same model behaves the same on all
    three databases. Set `foreignKeys: false` only for the case it exists for: loading
    a dump whose insert order does not respect the graph.

!!! info "A refused pragma is an error, not silence"

    SQLite answers a pragma it cannot honor by keeping the old value and **saying
    nothing**. Every pragma is read back after it is written, and a mismatch throws:

    ```ts
    createSyncEngine("sqlite://:memory:", { sqlite: { journalMode: "wal" } });
    // Error: SQLite refused PRAGMA journal_mode = wal for ":memory:" and stayed on
    //        "memory" — an in-memory database cannot use WAL.
    ```

    An in-memory database cannot do WAL. Better to learn that when the engine opens
    than when the latency did not improve.

!!! warning "A table-rebuilding migration turns FK enforcement back on"

    SQLite cannot alter a constraint, so the migration engine rebuilds the table
    (`CREATE new / copy / DROP old`), turning FK enforcement off around the copy and
    **back on** at the end. With `foreignKeys: false`, such a migration leaves it on.

Passing `sqlite` to a PostgreSQL or MySQL engine throws — pragmas do not exist there,
and silently ignoring them is how a durability choice gets lost.

## A wrong name is an error, not silence

A driver this package does not ship fails when the engine is created:

```ts
createSyncEngine("sqlite:///app.db", { driver: "sqlite3" });
// Error: Unknown SQLite driver "sqlite3"; supported: "node:sqlite" (built-in, default)
//        and "better-sqlite3".
```

!!! warning "The URL suffix is more forgiving — on purpose"

    `sqlite+aiosqlite:///app.db` and `postgresql+asyncpg://…` do **not** throw:
    those are Python-ecosystem drivers, and a URL copied from a Python service
    should still connect (on that database's default driver here). A suffix
    tempest-db-js recognizes selects; one it does not is ignored.

    The `driver` **option**, on the other hand, is an explicit choice you made in
    TypeScript — so it rejects what does not exist instead of ignoring it.

## PostgreSQL and MySQL

Each runs on exactly one driver (`postgres` / postgres.js and `mysql2`). Naming
that driver is accepted and changes nothing; naming another one throws, for the
same reason as above:

```ts
createEngine("postgresql://app@localhost/app", { driver: "postgres" }); // ok
createEngine("postgresql://app@localhost/app", { driver: "asyncpg" });
// Error: Unknown postgresql driver "asyncpg"; tempest-db-js runs postgresql on "postgres".
```

## Recap

- SQLite runs on `node:sqlite` by default — **zero install**.
- `{ driver: "better-sqlite3" }` or `sqlite+better-sqlite3://` switches drivers;
  the option wins over the suffix.
- `driverOptions` is forwarded to the chosen driver's constructor.
- An unknown name in the **option** throws; a foreign-ecosystem suffix in the
  **URL** is ignored, so Python service URLs keep working. 🚀
