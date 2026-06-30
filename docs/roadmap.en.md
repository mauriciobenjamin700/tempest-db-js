# Roadmap

tempest-db-js is built in phases, each one delivering a testable slice. **Phases 0–7
are complete** and shipped in `v0.1.0`; what's left are refinements and the
integration with `tempest-ts-sdk`.

| Phase | Theme | Status |
| --- | --- | --- |
| 0 | Toolchain + CI + type tests | ✅ Done |
| 1 | Class-based declarative schema + inference | ✅ Done |
| 2 | Typed query builder (SELECT/INSERT/UPDATE/DELETE) | ✅ Done |
| 3 | Operators typed per column type | ✅ Done |
| 4 | Dialects + real execution (`Session`) | ✅ + `.stream()`/pool; `using`/benchmark to do |
| 5 | Joins + composite types + relations | ✅ + relations + and/or/not |
| 6 | Migrations + CLI | ✅ + CLI + drift + batch SQLite + enum PG |
| 7 | `tempest-ts-sdk` integration + community | ✅ BaseRepository done; SDK to do |

## Done

### Phase 1 — Declarative schema

The `Model` class + the `column` factory with chainable modifiers. Row types
inferred by `InferModel` (SELECT) and `InferInsert` (INSERT), with correct
nullability and optionality. See [Models](tutorial/models.md).

### Phase 2 — Typed query builder

`select` with `Pick` projection, `where`/`orderBy`/`limit`/`offset`; `insert` typed
by `InferInsert` with `.returning()`; `update`/`del` with a **typed state guard**
against full-table writes. Pure AST, executed by the session layer (Phase 4). See
[Queries](tutorial/queries.md) and [Mutations](tutorial/mutations.md).

### Phase 3 — Typed operators

Operators restricted per column type at compile time: `like` only on `string`,
`gt`/`lt`/`between` only on `number`/`bigint`/`Date`, etc. `like` on a number **does
not compile**. See [Queries](tutorial/queries.md).

```ts
select(User).where({
  age:  { gt: 18 },        // ✅
  name: { like: "%Ben%" }, // ✅
  // age: { like: "%x%" }  // ❌ compile error
});
```

### Phase 4 — Real execution (4a + 4b done)

`getDialect(...).compile(node)` → parameterized `{ sql, params }` (4a). `createEngine`
(async) / `createSyncEngine` (SQLite sync), `Session.execute` with typed terminals
(`.all()`, `.first()`, `.one()`, `.scalar()`...), `engine.transaction` and savepoints
(4b). SQLite runs via `node:sqlite`; PostgreSQL via `postgres.js`. See
[Running queries](tutorial/execution.md). Still to do: 4c-4e (pool tuning, `using`,
`.stream()`, benchmark).

### Phase 5 — Joins + relations

`join(Model, alias).innerJoin/leftJoin(...)` → composite types
(`{ user: UserRow; order: OrderRow }`), with correct nullability on outer joins, plus
declarative relations `hasMany`/`belongsTo` + `loadRelations` (eager-load, no N+1) and
the `and`/`or`/`not` combinators. See [Joins](tutorial/joins.md) and
[Repository](repository.md). Still to do: per-column typed operators in the join `where`.

### Phase 6 — Migrations (done)

`reflectSchema`/`diffSchema`/`generateMigration`/`MigrationRunner` + DAG graph + **CLI**
(`runMigrationCli`) + **drift** (`checkDrift`/`introspectSqlite`) + **SQLite batch-mode**
+ **named PG enum**, Alembic-style, anti-"SQL-stitching". See [Migrations](migrations.md).

### Phase 7 — Repository (done) + SDK

`BaseRepository<Model>` (typed CRUD + pagination) + **relations** (`hasMany`/`belongsTo`).
See [Repository](repository.md). Still to do: the `tempest-ts-sdk` package consuming
tempest-db-js and HTTP integration recipes (Express/Hono/Fastify).

## Ahead

### Next refinements

Joins: per-column typed operators in `where`. Execution: `using`/asyncDispose,
benchmark vs Drizzle/Kysely. Migrations: interactive rename, executable bin.
PostgreSQL: validate introspection/enum/pool against a real database.

!!! info "Full details in the repository"

    The `ROADMAP.md` at the repo root has the detailed timeline, risks, and design
    decisions per phase.
