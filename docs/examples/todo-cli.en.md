# Todo CLI (SQLite)

A terminal task manager, from zero to working. It's the most didactic example: it shows
the **complete loop** — create the table, insert, list, complete, remove — in synchronous
SQLite, with no dependency beyond tempest-db-js.

!!! info "What you'll see"

    - A model with a managed timestamp.
    - Table creation via a one-off migration.
    - `insert ... returning`, `select` with a typed filter, `update`/`del` with a guard.

## 1. The model

```ts
import { Model, column, sql } from "tempest-db-js";

class Task extends Model {
  static tablename = "tasks";
  id = column.integer().primaryKey();
  title = column.text().notNull();
  done = column.boolean().notNull().default(false);
  createdAt = column.datetime().notNull().default(sql.now());
}
```

## 2. Database + table

We use the shared skeleton from the [gallery](index.en.md#the-shared-skeleton): a driver,
a migration that creates the table, and a session over the same driver.

```ts
import { NodeSqliteDriver, SyncEngine } from "tempest-db-js";
import { MigrationRunner, reflectTable, type Migration } from "tempest-db-js/migrations";

const driver = NodeSqliteDriver.open("todo.db");

const init: Migration = {
  revision: "init",
  downRevision: [],
  up: (op) => op.createTable(reflectTable(Task)),
  down: (op) => op.dropTable(reflectTable(Task)),
};
new MigrationRunner(driver, "sqlite").upgrade([init], new Date().toISOString());

const session = new SyncEngine(driver).session();
```

## 3. The operations

Each CLI command is a small function. Notice that **nothing is annotated by hand** — the
types come from the model.

```ts
import { insert, select, update, del } from "tempest-db-js";

/** Adds a task and returns the created row. */
function add(title: string) {
  const [task] = session
    .execute(insert(Task).values({ title }).returning())
    .all(); // returning() → TaskRow
  return task;
}

/** Lists tasks, optionally only the pending ones, newest first. */
function list(onlyPending = false) {
  const base = onlyPending ? select(Task).where({ done: false }) : select(Task);
  return session.execute(base.orderBy("createdAt", "desc")).all(); // TaskRow[]
}

/** Marks a task as completed. The .where() satisfies the guard. */
function complete(id: number) {
  return session.execute(update(Task).set({ done: true }).where({ id })).rowsAffected();
}

/** Removes a task. */
function remove(id: number) {
  return session.execute(del(Task).where({ id })).rowsAffected();
}
```

!!! warning "The guard protects you"

    `update(Task).set({ done: true })` **without** `.where()` won't compile when passed to
    `execute` — it's the guard against accidentally updating the whole table. To complete
    *all* tasks on purpose, it would be `.unguarded()`. See
    [Insert, update, delete](../tutorial/mutations.en.md#the-typed-guard-against-full-table-writes).

## 4. Wiring it to `process.argv`

```ts
const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "add":
    console.log("created:", add(rest.join(" ")));
    break;
  case "ls":
    for (const t of list(rest[0] === "--pending")) {
      console.log(`[${t.done ? "x" : " "}] #${t.id} ${t.title}`);
    }
    break;
  case "done":
    console.log(complete(Number(rest[0])) ? "completed" : "not found");
    break;
  case "rm":
    console.log(remove(Number(rest[0])) ? "removed" : "not found");
    break;
  default:
    console.log("usage: todo <add|ls [--pending]|done <id>|rm <id>>");
}

session.close();
```

## Running

```bash
node todo.js add "write the docs"
node todo.js add "publish to npm"
node todo.js ls
# [ ] #2 publish to npm
# [ ] #1 write the docs
node todo.js done 1
node todo.js ls --pending
# [ ] #2 publish to npm
```

## Recap

- The model carries the type **and** the schema; the migration materializes the table.
- `insert(...).returning()` returns the created row already typed.
- The `update`/`del` guard requires `.where()` — no full-table write by accident.
- Everything synchronous via the built-in `node:sqlite` — zero install.
