# Connecting to PostgreSQL

**Problem:** you developed against SQLite and now you want to run the same application on
PostgreSQL — without rewriting queries, and tuning the connection pool for production.

**Solution:** the database is identified by its **URL**. Switching from SQLite to PostgreSQL
is swapping the connection string; the same model, the same queries, and the same migrations
work for both. PostgreSQL runs through `postgres.js` (async-only).

## The theory in one sentence

`createEngine(url)` parses the URL (`parseDatabaseUrl`), picks the dialect, and instantiates
the right driver. The dialect compiles the **same AST** into idiomatic SQL for each database
(`?` in SQLite, `$1` in Postgres; native `ILIKE` in Postgres).

## 1. Install the driver

SQLite uses the built-in `node:sqlite`; PostgreSQL needs `postgres`:

```bash
npm install postgres
```

## 2. Swap the URL

```ts
import { createEngine } from "tempest-db-js";

// dev
const dev = createEngine("sqlite:///app.db");

// production — only the string changes
const prod = createEngine("postgresql://app:secret@db.internal:5432/app");
```

!!! info "An async driver suffix is accepted"

    SQLAlchemy-style URLs with a driver suffix (`postgresql+asyncpg://...`,
    `sqlite+aiosqlite://...`) are accepted — the suffix is ignored, the dialect comes from
    the base scheme. Handy for reusing the same `DATABASE_URL` from a Python backend.

## 3. Tune the pool (production)

PostgreSQL is async and uses a **connection pool**. Tune it via the second argument:

```ts
const engine = createEngine("postgresql://app:secret@db.internal/app", {
  pool: {
    size: 10,             // max simultaneous connections
    idleTimeoutMs: 30_000, // close idle connections after 30s
    connectTimeoutMs: 5_000, // give up connecting after 5s
  },
});
```

!!! note "The pool is ignored on SQLite"

    SQLite is a single connection (sync or async) — the pool options don't apply and are
    silently ignored. Only pass `pool` for PostgreSQL.

## 4. Everything is async

PostgreSQL **has no** synchronous engine (there's no serious sync driver in Node) —
`createSyncEngine` throws on Postgres. Use `createEngine` and `await`:

```ts
import { select } from "tempest-db-js";

const session = engine.session();
const users = await session.execute(select(User).where({ active: true })).all();
await session.close();
```

The rest of the API is identical to SQLite — terminals (`.all`/`.first`/`.one`/…),
transactions, streaming, and the mutation guard all work the same. See [Running queries](../tutorial/execution.en.md).

## 5. Migrations on Postgres

The same migration runs on both databases, with dialect-idiomatic DDL — you just tell the
runner the dialect:

```ts
const runner = new MigrationRunner(driver, "postgresql"); // instead of "sqlite"
```

On PostgreSQL, `column.enum(...)` becomes a named **`CREATE TYPE ... AS ENUM`**, and
`alter_column` is a direct `ALTER` (without the table-rebuild that SQLite requires). See the
[Migrations workflow](../examples/migrations-workflow.en.md).

!!! warning "PostgreSQL doesn't run in the project's CI yet"

    Introspection, the named enum, and the pool exist and are compiled, but they are not yet
    exercised against a real Postgres in CI (only SQLite is). Treat the Postgres path as
    **beta** and validate it in your own environment — see the [Roadmap](../roadmap.en.md).

## Recap

- The database is identified by its **URL** — switching databases is swapping the string.
- `createEngine(url, { pool: { size, idleTimeoutMs, connectTimeoutMs } })` for Postgres.
- PostgreSQL is **async-only**; SQLite ignores the pool.
- Same model, queries, and migrations on both; dialect-idiomatic DDL.
