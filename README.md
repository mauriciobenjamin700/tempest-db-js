# tempest-db-js

> Type-safe, class-based ORM for TypeScript — **SQLAlchemy 2.0 ergonomics** for the JS/TS world.
> Foundation package for the future **`tempest-ts-sdk`**.

📖 **Documentation:** [Português (BR)](https://mauriciobenjamin700.github.io/tempest-db-js/) · [English (US)](https://mauriciobenjamin700.github.io/tempest-db-js/en/)

> ✅ **Status: alpha (v0.2.0), published on [npm](https://www.npmjs.com/package/tempest-db-js).** The full path works end-to-end — declarative models, typed query builder (aggregations, `DISTINCT`, upsert), **real SQLite execution** (tested against `node:sqlite`), joins, relations, Alembic-style migrations + a `tempest-db` CLI, a typed `BaseRepository`, and an opt-in active-record layer. The public API may still shift before v1.0.

## Why tempest-db-js

You define a model **once**, as a class — tempest-db-js infers everything else:

```ts
import { Model, column, type InferModel, type InferInsert } from "tempest-db-js";

class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  age = column.integer().notNull();
  nickname = column.text();                 // nullable
  createdAt = column.timestamp().default(new Date());
}

type UserRow    = InferModel<typeof User>;
// { id: number; name: string; age: number; nickname: string | null; createdAt: Date | null }

type UserInsert = InferInsert<typeof User>;
// { name: string; age: number; nickname: string | null; id?: number; createdAt?: Date | null }
```

No manual `interface`, no codegen step, no schema/type drift. The class **is** the source of truth — just like SQLAlchemy's declarative `Mapped[...]`.

## The TypeScript reality

SQLAlchemy reads `Mapped[int]` at runtime via descriptors; TypeScript erases types at compile time. tempest-db-js bridges this by making each column a **runtime-typed builder** (`column.integer()`) that carries both its SQL type (runtime) and its static type (inference). You get class-based ergonomics **and** strong query-result inference — the trade-off being that returned rows are inferred plain objects, not active-record class instances (a post-MVP stretch goal).

## Install & run

```bash
npm install tempest-db-js
# SQLite needs no extra driver (uses Node's built-in node:sqlite).
# For PostgreSQL: npm install postgres
```

```ts
import { Model, column, select, insert, createSyncEngine } from "tempest-db-js";

class Task extends Model {
  static tablename = "tasks";
  id = column.integer().primaryKey();
  title = column.text().notNull();
  done = column.boolean().notNull();
}

const engine = createSyncEngine("sqlite://:memory:");
const session = engine.session();

session.execute(insert(Task).values({ title: "ship docs", done: false }));

const pending = session.execute(select(Task).where({ done: false })).all();
//    ^ inferred as { id: number; title: string; done: boolean }[] — no annotation
```

Real execution is tested against a live SQLite database (`node:sqlite`) — type coercion, `RETURNING`, transactions, and rollback included. PostgreSQL runs via `postgres.js`.

Sessions and engines are **disposable** — `using session = engine.session()` (or `await using engine = createEngine(...)`) closes the driver/pool automatically at scope exit.

## Beyond CRUD

Typed extras, each with a [docs recipe](https://mauriciobenjamin700.github.io/tempest-db-js/):

- **Aggregations** — `select(Order).aggregate(["status"], { n: count(), total: sum("amount") })` → rows typed as `{ status; n; total }`. Plus `.distinct()`.
- **Upsert** — `insert(Row).values(...).onConflictDoUpdate(["key"], { ... })` / `.onConflictDoNothing(["key"])` (portable SQLite ↔ PostgreSQL).
- **Active-record (opt-in)** — `activeRecord(User, session)` → `save`/`update`/`delete`/`reload` over `.data`; the plain-object default is unchanged.
- **Query logging & errors** — `createEngine(url, { onQuery })` traces every statement; a failed statement throws `QueryExecutionError` carrying the SQL + params.

## Migrations CLI

Alembic-style migrations ship with a `tempest-db` binary. Point it at a config that exports your driver, dialect, migrations, and models:

```ts
// tempest-db.config.mjs
import { defineMigrationConfig } from "tempest-db-js/migrations";
import { NodeSqliteDriver } from "tempest-db-js";
import { migrations } from "./migrations/index.js";
import { User } from "./models.js";

export default defineMigrationConfig({
  driver: NodeSqliteDriver.open("app.db"),
  dialect: "sqlite",
  migrations,
  models: [User],
});
```

```bash
npx tempest-db revision -m "add users" --autogenerate   # detects renames interactively
npx tempest-db upgrade                                   # apply pending migrations
npx tempest-db current | history | heads | check
```

HTTP integration recipes (Hono, Express, Fastify) live in the [docs](https://mauriciobenjamin700.github.io/tempest-db-js/).

## Roadmap

See [ROADMAP.md](./ROADMAP.md). Shipped: SQLite + PostgreSQL execution, joins, relations, migrations, repository. Next: `tempest-ts-sdk` integration and PostgreSQL CI against a live database.

## Development

```bash
npm install
npm run test:types   # tsc --noEmit — the type-level test suite
npm test             # vitest runtime tests
npm run build        # tsup → dual ESM + CJS + .d.ts
npm run bench        # SQLite benchmark vs Drizzle/Kysely (see BENCHMARKS.md)
```

## License

MIT
