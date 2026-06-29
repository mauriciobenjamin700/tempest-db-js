# Migrations

tempest-db-js has a migration system inspired by **Alembic** (SQLAlchemy), and
**explicitly different** from the "SQL-stitching" of other tools: everything flows
through a **Schema IR + typed operations**, and SQL is only born in the dialect
renderer. You never write nor version a loose `.sql` file.

Import from `tempest-db-js/migrations`:

```ts
import {
  reflectSchema, diffSchema, generateMigration,
  MigrationRunner, type Migration,
} from "tempest-db-js/migrations";
```

!!! info "State"

    The core (reflect, diff, render, codegen, DAG graph, runner) is ready and really
    runs against SQLite (`node:sqlite`). Introspection/drift and SQLite's batch-mode
    for `alter_column` are the next refinements — see the
    [Roadmap](roadmap.md).

## 1. From the model to the IR

`reflectSchema` reads your classes and produces the **IR** — the canonical,
dialect-independent description of the schema:

```ts
const target = reflectSchema([User, Post]);
// { tables: { users: { columns: {...}, primaryKey: ["id"] }, posts: {...} } }
```

## 2. Diff → typed operations

`diffSchema(current, target)` compares two IRs and emits **operations** — never SQL:

```ts
import { emptySchema } from "tempest-db-js/migrations";

const ops = diffSchema(emptySchema(), target);
// [ { kind: "create_table", table: {...} }, { kind: "create_table", ... } ]
```

Each operation has a **known inverse** (`invert`), which gives you `down()` automatically.

## 3. Autogenerate → migration file

`generateMigration` turns the operations into an **editable** TS file, with `up()`
and an inverted `down()`:

```ts
const src = generateMigration({
  revision: "a1b2c3",
  downRevision: [],
  label: "create users",
  operations: ops,
});
// TS string: export const up/down, operations embedded as data
```

## 4. Apply / revert

`MigrationRunner` renders the operations for the dialect and executes them via the
driver, tracking applied revisions in the `tempest_db_js_migrations` table:

```ts
import { NodeSqliteDriver } from "tempest-db-js";

const driver = NodeSqliteDriver.open("app.db");
const runner = new MigrationRunner(driver, "sqlite");

runner.upgrade(migrations, new Date().toISOString()); // apply pending (DAG order)
runner.downgrade(migrations, 1);                       // revert the last
```

A hand-written migration uses the `Op` facade:

```ts
const migration: Migration = {
  revision: "m1",
  downRevision: [],
  up: (op) => op.createTable(reflectTable(User)),
  down: (op) => op.dropTable(reflectTable(User)),
};
```

## 5. Revision graph (DAG)

`downRevision` is a **list of parents** — the history is a DAG, not a chain.
It supports parallel branches and merges. `topoOrder` orders them for applying
(parents before children, deterministic); `heads` shows the tips:

```ts
import { topoOrder, heads } from "tempest-db-js/migrations";

topoOrder(migrations); // application order
heads(migrations);      // revisions with no children (warns if > 1)
```

## 6. Column changes on SQLite (batch-mode)

SQLite doesn't do `ALTER COLUMN`. tempest-db-js solves this with a **table-rebuild** (just
like Alembic's batch mode): the `recreate_table` operation creates a new table with
the target schema, copies the common columns, and swaps the names — **preserving the
data**. On PostgreSQL the same operation turns into per-column `ALTER/ADD/DROP`.

```ts
// in a migration:
up: (op) => op.recreateTable(reflectTable(UserOld), reflectTable(UserNew)),
```

## 7. Drift: does the DB diverge from the models?

`introspectSqlite` reads the live schema from the database; `checkDrift` compares it
with the models and returns a list of divergences (empty = no drift). The comparison
is at the level of SQLite's **affinity**, so `varchar` vs `TEXT` is **not** a false
positive:

```ts
import { checkDrift } from "tempest-db-js/migrations";

const issues = checkDrift(driver, [User, Post]);
if (issues.length > 0) {
  console.error("schema drift:", issues); // great as a CI gate
}
```

## 8. CLI (programmatic)

`runMigrationCli(argv, config)` dispatches Alembic-style commands and returns lines +
an exit code (testable; a thin `bin` just wires it to `process.argv`/`process.exit`):

```ts
import { runMigrationCli } from "tempest-db-js/migrations";

const config = { driver, dialect: "sqlite" as const, migrations, models: [User, Post] };
runMigrationCli(["upgrade"], config);                       // apply pending
runMigrationCli(["upgrade", "--sql"], config);              // print SQL (offline)
runMigrationCli(["downgrade", "1"], config);                // revert
runMigrationCli(["current"], config);                       // applied revisions
runMigrationCli(["history"], config);                       // DAG
runMigrationCli(["heads"], config);                         // tips
runMigrationCli(["check"], config);                         // drift + diff (CI gate)
runMigrationCli(["revision", "-m", "x", "--autogenerate"], config); // generate migration
```

`replaySchema(migrations)` reconstructs the "current" IR without a database — it's what
`--autogenerate` compares against the models.

!!! note "PostgreSQL"

    `introspectPostgres`/`checkDriftPostgres` (via `information_schema`) and the **named
    enum** (`CREATE TYPE ... AS ENUM`) exist but are not exercised in CI (no Postgres in
    the environment). `PoolOptions` passes tuning through to `postgres.js`.

## Recap

- `reflectSchema(models)` → IR; `diffSchema(current, target)` → typed operations.
- `generateMigration(...)` → editable TS file with inverted `up()`/`down()`.
- `MigrationRunner.upgrade/downgrade` really applies/reverts, with a version table.
- **DAG** graph (`topoOrder`/`heads`) supports branch/merge.
- **SQL only in the dialect renderer** — never a loose `.sql` file.
