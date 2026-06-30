# tempest-db-js

> Type-safe, class-based ORM for TypeScript — **SQLAlchemy 2.0 ergonomics** for the JS/TS world.
> Foundation package for the future **`tempest-ts-sdk`**.

📖 **Documentation:** [Português (BR)](https://mauriciobenjamin700.github.io/tempest-db-js/) · [English (US)](https://mauriciobenjamin700.github.io/tempest-db-js/en/)

> ✅ **Status: alpha (v0.1.0), published on [npm](https://www.npmjs.com/package/tempest-db-js).** The full path works end-to-end — declarative models, typed query builder, **real SQLite execution** (tested against `node:sqlite`), joins, relations, Alembic-style migrations, and a typed `BaseRepository`. The public API may still shift before v1.0.

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

## Roadmap

See [ROADMAP.md](./ROADMAP.md). Shipped: SQLite + PostgreSQL execution, joins, relations, migrations, repository. Next: `tempest-ts-sdk` integration and PostgreSQL CI against a live database.

## Development

```bash
npm install
npm run test:types   # tsc --noEmit — the type-level test suite
npm test             # vitest runtime tests
npm run build        # tsup → dual ESM + CJS + .d.ts
```

## License

MIT
