# Installation

## Requirements

- **Node.js ≥ 20** (or a compatible runtime).
- **TypeScript ≥ 5.7** — tempest-db-js relies on modern type-inference features. Older
  versions may not infer rows correctly.

!!! success "Available on npm (`v0.1.0`)"

    tempest-db-js is published on [npm](https://www.npmjs.com/package/tempest-db-js)
    and usable end to end. Install it with your favorite package manager:

## Install

=== "npm"

    ```bash
    npm install tempest-db-js
    ```

=== "pnpm"

    ```bash
    pnpm add tempest-db-js
    ```

=== "yarn"

    ```bash
    yarn add tempest-db-js
    ```

## Database drivers (peer dependencies)

tempest-db-js does **not** bundle a database driver — you pick and install the one you
need. The drivers are **optional** `peerDependencies`, so installing tempest-db-js
doesn't pull in any database.

| Database | Driver | Package |
| --- | --- | --- |
| SQLite | `node:sqlite` (built into Node) | **nothing to install** |
| SQLite (alternative) | `better-sqlite3` | `npm install better-sqlite3` |
| PostgreSQL | `postgres` (postgres.js) | `npm install postgres` |

!!! tip "SQLite works with no install"

    By default tempest-db-js uses the **`node:sqlite` module built into Node ≥ 20** —
    so you can already run real SQLite queries with no extra package.
    `better-sqlite3` is an optional alternative; PostgreSQL needs `postgres`.

## TypeScript configuration

tempest-db-js assumes a `tsconfig.json` in **strict** mode. The recommended minimum:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

!!! tip "Why `strict`?"

    tempest-db-js's inference is built on top of TS's strict type system. With
    `strict: false`, column nullability (`string | null`) and the UPDATE/DELETE
    guards lose their strength — exactly the guarantees you adopted a typed ORM
    for. Keep `strict: true`.

## Verify the installation

A complete program that **creates the table, inserts, and reads** — using only the public API:

```ts
import {
  Model, column, select, insert, createSyncEngine, NodeSqliteDriver,
} from "tempest-db-js";
import { MigrationRunner, reflectTable, type Migration } from "tempest-db-js/migrations";

class Ping extends Model {
  static tablename = "ping";
  id = column.integer().primaryKey();
  label = column.text().notNull();
}

// 1. create the table with a one-off migration (details in "Migrations")
const driver = NodeSqliteDriver.open("verify.db");
const migration: Migration = {
  revision: "init",
  downRevision: [],
  up: (op) => op.createTable(reflectTable(Ping)),
  down: (op) => op.dropTable(reflectTable(Ping)),
};
new MigrationRunner(driver, "sqlite").upgrade([migration], new Date().toISOString());

// 2. run typed queries against the same database
const session = createSyncEngine("sqlite:///verify.db").session();
session.execute(insert(Ping).values({ label: "ok" }));
console.log(session.execute(select(Ping)).all()); // [{ id: 1, label: "ok" }]
```

If this runs without errors (and compiles with `tsc --noEmit`), you're all set. ✅

!!! tip "Just want a quick smoke test?"

    To confirm only the import and typing, without touching disk, build a query
    and inspect the AST: `console.log(select(Ping).node.table) // "ping"`.

## Recap

- Node ≥ 20, TypeScript ≥ 5.7, `strict: true`.
- `npm install tempest-db-js` — already on npm (`v0.1.0`).
- SQLite runs out of the box (built-in `node:sqlite`); for PostgreSQL, `npm install postgres`.
- Next: build your first model in the **[Tutorial](tutorial/index.md)**.
