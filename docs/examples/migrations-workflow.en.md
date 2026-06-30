# Migrations workflow

How to evolve the schema of a real project from start to finish: generate the first
migration, apply it, change a model, generate the next one, and lock down **drift** in CI
— all without writing a loose `.sql`. It's the practical complement to the
[Migrations](../migrations.en.md) guide.

!!! info "The principle"

    The **models** are the source of truth. You change the class; tempest-db-js **computes
    the diff** against the current state and generates the typed operations. The SQL is only
    born in the dialect renderer, at apply time.

## 1. Initial state → first migration

You have the models and an empty database. `reflectSchema` reads the classes and `diffSchema`
compares them with the empty one to emit the operations; `generateMigration` turns it into
a TS file:

```ts
import {
  reflectSchema, diffSchema, emptySchema, generateMigration,
} from "tempest-db-js/migrations";

const target = reflectSchema([User, Post]);          // IR of the current models
const ops = diffSchema(emptySchema(), target);        // [] → target  ⇒  create_table...

const src = generateMigration({
  revision: "0001_init",
  downRevision: [],
  label: "create users and posts",
  operations: ops,
});
// `src` is the content of an editable .ts file, with an inverted up()/down().
```

Save `src` to `migrations/0001_init.ts` and commit it to git.

## 2. Apply

`MigrationRunner` renders the operations for the dialect and runs them, recording what has
already run in the `tempest_db_js_migrations` table:

```ts
import { NodeSqliteDriver } from "tempest-db-js";
import { MigrationRunner } from "tempest-db-js/migrations";
import { migrations } from "./migrations";  // your migrations imported in order

const driver = NodeSqliteDriver.open("app.db");
const runner = new MigrationRunner(driver, "sqlite");

runner.upgrade(migrations, new Date().toISOString()); // applies the pending ones (DAG order)
```

## 3. Evolve the schema → next migration

You add a `published` field to `Post`. Instead of writing the `ALTER` by hand, let the diff
compute it — `replaySchema` reconstructs the "current" state from the migrations already
written, and you compare it with the new models:

```ts
import { replaySchema, diffSchema, reflectSchema, generateMigration } from "tempest-db-js/migrations";

const current = replaySchema(migrations);            // state according to the history
const target = reflectSchema([User, Post]);          // new models (with `published`)
const ops = diffSchema(current, target);             // ⇒ add_column published

const next = generateMigration({
  revision: "0002_post_published",
  downRevision: ["0001_init"],
  label: "add published to posts",
  operations: ops,
});
```

!!! tip "Or via the CLI"

    `runMigrationCli` does this for you, Alembic-style:

    ```ts
    import { runMigrationCli } from "tempest-db-js/migrations";

    const config = { driver, dialect: "sqlite" as const, migrations, models: [User, Post] };
    runMigrationCli(["revision", "-m", "add published", "--autogenerate"], config);
    runMigrationCli(["upgrade"], config);          // applies pending ones
    runMigrationCli(["upgrade", "--sql"], config); // only prints the SQL (offline)
    runMigrationCli(["downgrade", "1"], config);   // reverts the last one
    runMigrationCli(["history"], config);          // shows the DAG
    ```

## 4. Revert

```ts
runner.downgrade(migrations, 1); // undoes the last revision (uses the inverted down())
```

Since each operation has a **known inverse**, the `down()` is generated automatically — a
`create_table` becomes a `drop_table`, an `add_column` becomes a `drop_column`, etc.

## 5. Drift gate in CI

The worst-case scenario is the database and the models silently diverging. `checkDrift`
reads the **live** schema from the database and compares it with the models — an empty list
means all good:

```ts
import { checkDrift } from "tempest-db-js/migrations";

const issues = checkDrift(driver, [User, Post]);
if (issues.length > 0) {
  console.error("schema drift detected:", issues);
  process.exit(1); // fail the pipeline
}
```

Put this in a CI step: if someone changed a model without generating the migration (or
applied a manual SQL to the database), the build **breaks** before reaching production.

!!! check "Why no 'SQL stitching'"

    Everything flows through a **Schema IR + typed operations**; the SQL only appears in the
    dialect renderer. You never write or version a loose `.sql`, the `down()` is derived, and
    the same migration runs on SQLite and PostgreSQL with each one's idiomatic DDL.

## Recap

- `reflectSchema` + `diffSchema` + `generateMigration` → first migration from the models.
- `replaySchema` reconstructs the current state to compute the **next** migration's diff.
- `MigrationRunner.upgrade/downgrade` applies/reverts for real, with a version table and DAG.
- `runMigrationCli` provides the Alembic-style commands; `checkDrift` is your CI gate.
