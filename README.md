# tempest-db-js

> Type-safe, class-based ORM for TypeScript — **SQLAlchemy 2.0 ergonomics** for the JS/TS world.
> Foundation package for the future **`tempest-ts-sdk`**.

📖 **Documentation:** [Português (BR)](https://mauriciobenjamin700.github.io/tempest-db-js/) · [English (US)](https://mauriciobenjamin700.github.io/tempest-db-js/en/)

> ✅ **Status: alpha (v0.6.0), published on [npm](https://www.npmjs.com/package/tempest-db-js).** The full path works end-to-end — declarative models with **foreign keys, UNIQUE, table constraints, explicit column names and PostgreSQL arrays**, a typed query builder (aggregations with **`HAVING`**, `DISTINCT`, upsert with **partial-index predicates**, **`FOR UPDATE SKIP LOCKED`**, **subqueries in `IN`**, SQL expressions in writes and in `where`), **real execution on all three databases — SQLite, PostgreSQL and MySQL, each tested in CI against a live server**, joins, relations, Alembic-style migrations with an **async** `tempest-db` CLI that runs on every dialect, a typed `BaseRepository`, an opt-in active-record layer, and a `session.raw` escape hatch. The public API may still shift before v1.0.

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

- **Schema constraints** — column `.unique()` / `.references("users.id", { onDelete })` and composite/named table constraints via `static tableArgs = () => [unique(...), foreignKey(...)]` (SQLAlchemy `ForeignKey`/`__table_args__` style). Rendered across all dialects; reversible in migrations.
- **Aggregations** — `select(Order).aggregate(["status"], { n: count(), total: sum("amount") })` → rows typed as `{ status; n; total }`. Plus `.distinct()`.
- **Upsert** — `insert(Row).values(...).onConflictDoUpdate(["key"], { ... })` / `.onConflictDoNothing(["key"])` (portable SQLite ↔ PostgreSQL).
- **Active-record (opt-in)** — `activeRecord(User, session)` → `save`/`update`/`delete`/`reload` over `.data`; the plain-object default is unchanged.
- **Query logging & errors** — `createEngine(url, { onQuery })` traces every statement; a failed statement throws `QueryExecutionError` carrying the SQL + params.
- **Durable queues** — `select(Job).where(...).limit(10).forUpdate({ skipLocked: true })` inside a transaction hands each worker a disjoint batch, and `set({ attempts: sql.raw("attempts + 1") })` increments in the database instead of read-modify-write. SQLite throws rather than emitting an unlocked `SELECT`.
- **Partial-index upsert** — `onConflictDoNothing(["consumer", "idempotencyKey"], { where: { idempotencyKey: { isNull: false } } })` repeats the index predicate PostgreSQL requires to match a **partial** unique index as a conflict target.
- **Column names** — `.name("consumer_name")` per column, or `static naming = "snake_case"` per table: a `snake_case` schema behind a `camelCase` model, mapped everywhere including the migration IR (so no false drift).
- **PostgreSQL arrays** — `column.array(column.text())` → `text[]` typed as `string[]`, with `contains` (`@>`), `containedBy` (`<@`) and `overlaps` (`&&`) in `where`.
- **Case-insensitive lookups** — `{ ieq: probe }` → `lower(col) = lower($1)`: no wildcards, matches a `lower(col)` functional index. (`ilike` is pattern matching — `{ ilike: "%" }` matches every row.)
- **Raw SQL escape hatch** — `session.raw(sql, params, { as: Model })` for the query the builder cannot yet express, always parameterized and integrated with logging, errors and transactions.
- **Subqueries** — `where({ id: { in: select(Job).where(...).forUpdate({ skipLocked: true }).asSubquery("id") } })` collapses the queue claim into one statement instead of two round trips.
- **`HAVING`** — `.aggregate(["customer"], { n: count() }).having({ n: { gt: 10 } })`, typed against the aliases and unreachable before you group.
- **Expressions in `where`** — `col<OrderRow>("total").gt(col<OrderRow>("paid"))` and `fn.lower("email").eq(fn.lower(val(probe)))`, so a functional index is actually used.
- **MySQL `RETURNING`** — `.returning()` on a single-row insert reads the row back by `LAST_INSERT_ID()` on the same connection, which is what makes `BaseRepository.create()` and `activeRecord.save()` work there.

## Migrations CLI

Alembic-style migrations ship with a `tempest-db` binary, running on **every dialect** — point it at a config that exports your driver (sync or async), dialect, migrations, and models:

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

See [ROADMAP.md](./ROADMAP.md). Shipped (v0.6.0): declarative schema with foreign keys / UNIQUE / table constraints / explicit column names / PostgreSQL arrays, real execution on **all three databases** (SQLite, PostgreSQL and MySQL, each tested in CI against a live server), row locking, SQL expressions in writes and in `where`, subqueries in `IN`, `HAVING`, partial-index upsert, `session.raw`, joins, relations, an async `tempest-db` CLI that migrates every dialect, repository, opt-in active-record. Next: `EXISTS`/scalar subqueries, MySQL `information_schema` introspection, then `tempest-ts-sdk`.

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
