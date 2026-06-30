# Architecture

This page explains **the design decisions** behind tempest-db-js — why it is the way it
is. If you just want to use the ORM, the [Tutorial](tutorial/index.md) is enough.
If you want to understand it (or contribute), start here.

## The core constraint: TypeScript erases types

SQLAlchemy 2.0 can read `Mapped[int]` at **runtime**, because Python keeps type
annotations accessible via `typing.get_type_hints` and uses descriptors to make
`User.id` mean different things on class access (a column reference) and instance
access (a value).

TypeScript has **none** of that: types are erased at compile time. At runtime,
`id: number` simply doesn't exist. So a class like this would be **invisible** to
the ORM:

```ts
class User {
  id: number;     // ❌ vanishes at runtime — the ORM doesn't know a column exists
  name: string;
}
```

## The solution: the column is a value

tempest-db-js makes each column a **runtime value** that carries the type:

```ts
class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();   // runtime: Column object | type: Column<number, {...}>
  name = column.text().notNull();
}
```

The `Column` object:

- stores at runtime the SQL type (`"INTEGER"`) and flags (`primaryKey`, `notNull`,
  `hasDefault`);
- carries a **phantom type** `T` (via a `declare` symbol) that exists only in the
  type system, never at runtime.

From that, mapped types extract the shape of the row:

```ts
type ColValue<Col> = Col extends Column<infer T, infer F>
  ? F extends { notNull: true } | { primaryKey: true } ? T : T | null
  : never;

type InferModel<C> = { [K in ColumnKeys<InstanceType<C>>]: ColValue<InstanceType<C>[K]> };
```

!!! info "Same principle as Drizzle/Kysely"

    Drizzle and Kysely solved the same problem the same way: the column is a
    builder-value, not an annotation. tempest-db-js adopts that foundation and wraps it
    in a **declarative class**, to stay close to SQLAlchemy.

## The honest trade-off

Because the column is a value, the returned row **cannot** be an instance of the
class with methods (you can't have `User.id` be both `Column<number>` for
building a query and `number` for reading a value, without Python's descriptor
trick). So:

- **Rows are inferred plain objects** (`InferModel`), not active instances.
- **Active-record** (methods on the row instance, like `user.save()`) is a
  **post-MVP** goal.

In return, we get **strong query inference** — what matters most in a typed ORM.

## The query builder: pure AST + phantom types

The builders (`select`, `insert`, `update`, `del`) **don't execute anything**.
Each one:

1. accumulates a **serializable AST** (`SelectNode`, `InsertNode`, ...), exposed at
   `.node`;
2. carries **phantom types** that describe the result, with no runtime cost.

Execution is a **separate** layer (`session.execute` + dialects), which compiles
the AST to parameterized SQL and runs it against the database. Separating "build"
from "execute" makes all the type safety testable with `tsc` alone (no database
needed) and makes each builder reusable in any session.

### Two type parameters in `select`

```ts
class SelectBuilder<Full, Proj = Full> { ... }
```

- **`Full`** — the complete row. Used to type the **keys** of `where`/`orderBy`.
- **`Proj`** — the projection. It's what execution **returns**.

Without a projection, `Proj = Full`. With `select(User, ["id"])`,
`Proj = Pick<Full, "id">`. Keeping the two separate lets you filter by a column
that isn't in the projection.

### The state guard in UPDATE/DELETE

`update` and `del` carry a type parameter `Guarded extends boolean`:

```ts
class UpdateBuilder<Full, Guarded extends boolean, Ret = number> { ... }
```

- they start with `Guarded = false`;
- `.where(...)` or `.unguarded()` produce `Guarded = true`;
- `session.execute` accepts **only** `Guarded = true` builders (type `Executable`).

Result: an `UPDATE`/`DELETE` without a `WHERE` and without an explicit opt-in is a
**compile-time error**, not a production accident. See
[Insert, update, delete](tutorial/mutations.md).

## Why all of this is testable with `tsc`

Because builders are pure type + AST, tempest-db-js's tests are mostly **type tests**
(`expectTypeOf`, `@ts-expect-error`). A filter with an invalid key or an update
without a guard **fails to compile** — and that's exactly what the tests verify.
In a typed ORM, the type **is** the product, so the type test is the product test.

## Module map

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | `Model`, `column`, `InferModel`/`InferInsert`, `sql` + re-exports |
| `src/query.ts` | `select`, `SelectBuilder`, the SELECT AST, `WhereInput`, operators |
| `src/mutations.ts` | `insert`/`update`/`del`, builders, state guard, AST |
| `src/conditions.ts` | `and`/`or`/`not` combinators and the `Condition` tree |
| `src/dialect.ts` | compiles AST → parameterized SQL (`SqliteDialect`/`PostgresDialect`) |
| `src/engine.ts` | `createEngine`/`createSyncEngine`, session, transactions, drivers |
| `src/join.ts` | `join`, composite types per alias, `leftJoin` nullability |
| `src/relations.ts` | `hasMany`/`belongsTo` + `loadRelations` (eager-load, no N+1) |
| `src/repository.ts` | `BaseRepository<Model>` — CRUD + typed pagination |
| `src/serialize.ts` | row ↔ dict ↔ JSON coercion per column type |
| `src/migrations/*` | Schema IR, diff, codegen, DAG, runner, CLI (Alembic-style) |

## Recap

- TS erases types → the column must be a **value** that carries the type.
- Rows are inferred plain objects; active-record is post-MVP.
- Builders are **pure AST + phantom types**; execution is a separate layer.
- `SelectBuilder<Full, Proj>` separates the filter key from the projected result.
- `Guarded extends boolean` turns an accidental full-table write into a
  compile-time error.
