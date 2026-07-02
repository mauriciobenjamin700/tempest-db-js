# tempest-db-js

**tempest-db-js** is a **type-safe**, **class-based** ORM for TypeScript. It brings the
ergonomics of **SQLAlchemy 2.0** — models declared as classes, schema as the
single source of truth — to the JS/TS world, with strong type inference from
start to finish: you define the table once and TypeScript knows the shape of
every row across every `select`, `insert`, `update`, and `delete`.

It's the data layer for the upcoming **`tempest-ts-sdk`**.

> :material-translate: **Idiomas / Languages** — this documentation is bilingual.
> Use the language selector at the top of the page to switch between
> **Português (BR)** and **English (US)**.

!!! success "Status: alpha (`v0.2.0`) — published on [npm](https://www.npmjs.com/package/tempest-db-js)"

    The full path works end to end: declarative schema, typed query builder,
    **real execution on SQLite** (tested against `node:sqlite`), joins,
    relations, Alembic-style migrations, and a typed `BaseRepository`. The
    public surface may still change before `v1.0` — see the [Roadmap](roadmap.md).

## Why tempest-db-js?

You define the model **once**, as a class — and tempest-db-js infers everything else:

```ts
import { Model, column, type InferModel, type InferInsert } from "tempest-db-js";

class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  age = column.integer().notNull();
  nickname = column.text();                  // nullable
  createdAt = column.timestamp().default(new Date());
}

type UserRow    = InferModel<typeof User>;
// { id: number; name: string; age: number; nickname: string | null; createdAt: Date | null }

type UserInsert = InferInsert<typeof User>;
// { name: string; age: number; nickname: string | null; id?: number; createdAt?: Date | null }
```

No hand-written `interface`, no codegen step, no schema and type drifting apart.
The class **is** the source of truth — just like SQLAlchemy's declarative
`Mapped[...]`.

And the inference propagates into your queries:

```ts
import { select } from "tempest-db-js";

// The result is inferred as UserRow[] — no manual annotation
const adults = select(User).where({ age: { gt: 18 } }).orderBy("age", "desc");

// Projection infers Pick<UserRow, "id" | "name">[]
const names = select(User, ["id", "name"]);
```

## The TypeScript reality

SQLAlchemy reads `Mapped[int]` at **runtime** via descriptors; TypeScript
**erases the types** at compile time. tempest-db-js works around this by making each
column a **builder with a runtime type** (`column.integer()`) that carries both
the SQL type (runtime) and the static type (inference) at the same time.

You get the ergonomics of classes **and** strong query-result inference. The
trade-off: the returned row is an inferred plain object, not a class instance
with methods (active-record is a post-MVP goal). Details in
[Architecture](architecture.md).

## Get started in 1 minute

```bash
npm install tempest-db-js
```

SQLite needs no extra driver (it uses Node's built-in `node:sqlite`). For
PostgreSQL, `npm install postgres`.

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

session.execute(insert(Task).values({ title: "write docs", done: false }));

const pending = session.execute(select(Task).where({ done: false })).all();
// `pending` is { id: number; title: string; done: boolean }[] — no manual annotation
```

Execution is real and tested against an actual SQLite database (`node:sqlite`):
type coercion, `RETURNING`, transactions, and rollback. PostgreSQL runs via `postgres.js`.

New here? Follow the **[Tutorial — Start here](tutorial/index.md)**: from your
first model to running queries against a database, one concept per page.

## What's inside

| Area | Pages |
| --- | --- |
| **Tutorial** | [Start here](tutorial/index.md) · [Models](tutorial/models.md) · [Queries](tutorial/queries.md) · [Insert, update, delete](tutorial/mutations.md) · [Running queries](tutorial/execution.md) · [Joins](tutorial/joins.md) |
| **Recipes** | [created_at/updated_at](recipes/timestamps.md) · [Pagination](recipes/pagination.md) · [Transactions](recipes/transactions.md) · [JSON & enum](recipes/json-enum.md) · [Serialization](recipes/serialization.md) · [PostgreSQL](recipes/postgres.md) |
| **Examples** | [Todo CLI](examples/todo-cli.md) · [Blog](examples/blog.md) · [REST API](examples/rest-api.md) · [Migrations workflow](examples/migrations-workflow.md) |
| **Guide** | [Architecture](architecture.md) · [Repository](repository.md) · [Migrations](migrations.md) · [API reference](reference.md) |
| **Project** | [Roadmap](roadmap.md) · [Contributing](contributing.md) · [Changelog](changelog.md) |

## Principles

1. **The type is the product.** Every feature ships type tests, not just runtime tests.
2. **Zero string SQL.** Always parameterized — injection-safe by construction.
3. **Class-first, but honest with TS.** We embrace what TS does well.
4. **Docs follow the code.** Bilingual, tutorial-style, in the same commit.
