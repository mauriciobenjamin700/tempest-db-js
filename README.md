# Querium

> Type-safe, class-based ORM for TypeScript — **SQLAlchemy 2.0 ergonomics** for the JS/TS world.
> Foundation package for the future **`tempest-ts-sdk`**.

📖 **Documentation:** [Português (BR)](https://mauriciobenjamin700.github.io/querium/) · [English (US)](https://mauriciobenjamin700.github.io/querium/en/)

> ⚠️ **Status: pre-alpha (v0.0.0).** Phase 1 type-inference is proven; the public API is still taking shape. Not yet published to npm.

## Why Querium

You define a model **once**, as a class — Querium infers everything else:

```ts
import { Model, column, type InferModel, type InferInsert } from "querium";

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

SQLAlchemy reads `Mapped[int]` at runtime via descriptors; TypeScript erases types at compile time. Querium bridges this by making each column a **runtime-typed builder** (`column.integer()`) that carries both its SQL type (runtime) and its static type (inference). You get class-based ergonomics **and** strong query-result inference — the trade-off being that returned rows are inferred plain objects, not active-record class instances (a post-MVP stretch goal).

## Roadmap

See [ROADMAP.md](./ROADMAP.md). Targets: **SQLite** (`better-sqlite3`) then **PostgreSQL** (`postgres.js`), performance-first.

## Development

```bash
npm install
npm run test:types   # tsc --noEmit — the type-level test suite
npm test             # vitest runtime tests
npm run build        # tsup → dual ESM + CJS + .d.ts
```

## License

MIT
