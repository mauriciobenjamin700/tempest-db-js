# Examples gallery

While the [Recipes](../recipes/index.en.md) solve an isolated problem, the **examples**
are **complete little projects that run** — from `CREATE TABLE` to the last query — so you
can see the pieces fit together. Each one is copy-paste and self-contained.

## The projects

<div class="grid cards" markdown>

- :material-console: **[Todo CLI (SQLite)](todo-cli.en.md)**

    A terminal task manager. Creates the table via a migration, inserts, lists and
    completes — the **complete loop** in synchronous SQLite. Start here.

- :material-post: **[Blog (relations + joins)](blog.en.md)**

    `users` → `posts` → `comments`. Shows `hasMany`/`belongsTo` + `loadRelations`
    (no N+1) and typed composite joins. The **relational modeling** example.

- :material-api: **[REST API (Hono + Repository)](rest-api.en.md)**

    HTTP endpoints backed by `BaseRepository`, with typed pagination and the 404 convention.
    The bridge to the `tempest-fastapi-sdk` / `tempest-ts-sdk` world.

- :material-server: **[REST API (Express + Repository)](express-api.en.md)**

    The same API on Node's most widespread HTTP framework. The data layer is
    identical — only the shell changes.

- :material-lightning-bolt: **[REST API (Fastify + Repository)](fastify-api.en.md)**

    The same API on Fastify, with per-route typed `Params`/`Body`/`Querystring`
    matching the repository types.

- :material-database-sync: **[Migrations workflow](migrations-workflow.en.md)**

    The schema lifecycle: `autogenerate`, `upgrade`/`downgrade` and a **drift gate in CI**.
    How to evolve the database without writing loose SQL.

</div>

## The shared skeleton

All the SQLite examples use the same skeleton to get a ready table: a single driver,
a one-off migration that creates the tables, and a session over **the same driver**.

```ts
import { NodeSqliteDriver, SyncEngine } from "tempest-db-js";
import { MigrationRunner, reflectTable, type Migration } from "tempest-db-js/migrations";

const driver = NodeSqliteDriver.open(":memory:");   // an in-memory database

const init: Migration = {
  revision: "init",
  downRevision: [],
  up: (op) => op.createTable(reflectTable(MyModel)),
  down: (op) => op.dropTable(reflectTable(MyModel)),
};
new MigrationRunner(driver, "sqlite").upgrade([init], new Date().toISOString());

const session = new SyncEngine(driver).session();   // session over the SAME driver
```

!!! tip "Why the same driver?"

    A `:memory:` database belongs to the connection that opened it. Reusing the **same `driver`**
    between the `MigrationRunner` and the `SyncEngine` ensures the session sees the tables the
    migration created. For a file-based database (`sqlite:///app.db`), different connections
    also see the same schema.
