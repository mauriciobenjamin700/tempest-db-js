# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adopts [Semantic Versioning](https://semver.org/).

## [0.5.0] — 2026-08-30

A cycle focused on the gaps the first real service migration (`zap-api`, a WhatsApp
gateway) ran into — the outbox/queue pattern on PostgreSQL, end to end.

### Added

- **Row locking** — `.forUpdate({ skipLocked, noWait, of })` and `.forShare(...)`
  on `SelectBuilder` (mirrors SQLAlchemy's `with_for_update()`). Renders
  `FOR UPDATE [OF ...] [SKIP LOCKED | NOWAIT]` on PostgreSQL and MySQL 8.0+;
  SQLite **throws an explicit error** instead of emitting an unlocked `SELECT`. A
  lock combined with `DISTINCT`/an aggregate throws too. Unblocks the job-queue
  pattern with competing workers.
- **SQL expressions as write values** — `sql.raw("attempts + 1")`,
  `` sql.expr`balance - ${amount}` `` (a tagged template where every `${}` becomes a
  bound parameter) and the portable tokens (`sql.now()`, `sql.uuidv4()`, …) now work
  in `.set()` and `.values()`, not only in `.default()`. The counter is incremented
  in the database, with no read-modify-write and no race. Every expression carries a
  brand (`isSqlExpression`) the dialect recognizes.
- **A predicate on the conflict target** — `onConflictDoNothing(target, { where })`
  and `onConflictDoUpdate(target, set, { indexWhere, updateWhere })` emit
  `ON CONFLICT (...) WHERE <predicate>`, which PostgreSQL requires for a **partial
  unique index** to match as a conflict target. Portable to SQLite; MySQL throws an
  explicit error.
- **`session.raw(sql, params, { as })`** — a runtime raw-SQL escape hatch, the
  counterpart of migrations' `Op.execute`, on both async and sync sessions. Always
  parameterized, integrated with `onQuery`, `QueryExecutionError` and the
  transaction's reserved connection; `{ as: Model }` coerces rows through the
  model's types.
- **Explicit column names and a naming strategy** — `.name("consumer_name")` per
  column (`mapped_column("...")` style) and `static naming = "snake_case"` per
  table. The mapping applies across select/insert/update/delete, `where`,
  `orderBy`, `groupBy`, aggregates, `returning`, conflict targets, joins,
  `BaseRepository`, active-record **and the migration IR** — so it produces no false
  drift. The returned row stays in property-name space. A name collision fails
  loudly.
- **`column.array(element)`** — PostgreSQL `text[]`/`integer[]` columns, with `T[]`
  inferred, `DEFAULT ARRAY[...]::type[]`, and introspection (`data_type = ARRAY` +
  `udt_name`) and drift aware of the element type. SQLite and MySQL throw an
  explicit error instead of silently falling back to JSON.
- **New operators** — `ieq` (case-insensitive equality → `lower(col) = lower($1)`,
  portable across all three dialects and matching a functional index) and the array
  operators `contains` (`@>`), `containedBy` (`<@`) and `overlaps` (`&&`),
  PostgreSQL-only.
- **Docs** — five new bilingual recipes: A durable queue on PostgreSQL, Column
  names, PostgreSQL array columns, Case-insensitive comparison and Raw SQL at
  runtime. An integration suite against a real PostgreSQL covering concurrent
  locking, the partial index, arrays and the atomic counter.

### Fixed

- **`set()`/`values()` silently wrote garbage.** A non-scalar value —
  `{ raw: "attempts + 1" }`, an array on a scalar column, a function — was **bound
  as a parameter**, and the driver serialized it (or stored `null`) with no error at
  all: an `INTEGER NOT NULL` column became `null`. Now any value that is neither a
  scalar nor a branded expression raises `ValidationError` while the query is built,
  naming the column and the expected type. A key that is not a column of the model
  is rejected too.
- **The INSERT template cache** must not serve statements carrying a conflict
  predicate or an expression among the values, whose SQL depends on the values.
  Those take an uncached path that renders the clauses in statement order, keeping
  placeholder positions correct.
- **PostgreSQL introspection** read every array column as `text`, which made
  `checkDriftPostgres` report drift forever on a correct schema.

### Documented

- `ilike` is **pattern matching**, not equality: `%` and `_` are wildcards, and
  `{ ilike: "%" }` matches every row. Used as a "case-insensitive eq" in an
  authentication lookup, it is a login bypass. The operator's documentation now says
  so, and `ieq` exists precisely to remove the temptation.

### Known limitations

- `FOR UPDATE`/`FOR SHARE`, the `ON CONFLICT` predicate and `column.array()` have no
  equivalent on every dialect; each throws an explicit error where it is
  unsupported, rather than degrading silently.
- Subqueries in `WHERE ... IN (...)` are still outside the builder — the queue
  pattern is written as `SELECT ... FOR UPDATE SKIP LOCKED` followed by
  `UPDATE ... WHERE id IN (ids)` in the same transaction, or via `session.raw`.

## [0.4.0] — 2026-07-09

### Added

- **Foreign keys, UNIQUE and table constraints** — column-level `.references(...)`
  and `.unique()` (SQLAlchemy `mapped_column(ForeignKey(...), unique=True)` style)
  plus `static tableArgs = () => [unique(...), foreignKey(...)]` for composite/named
  (`__table_args__` style). Rendered across all three dialects, with reversible
  `add_constraint`/`drop_constraint` operations, diff, replay and drift detection.
  See the [Foreign keys & UNIQUE](recipes/constraints.en.md) recipe.

## [0.1.0] — 2026-06-29

First public release, published on [npm](https://www.npmjs.com/package/tempest-db-js).

### Added

- **Phase 1 — class-based declarative schema.** The `Model` base class + the
  `column` factory with a rich type catalog mirroring SQLAlchemy (`smallInteger`,
  `integer`, `bigInteger`→`bigint`, `numeric`/`decimal`→`string`, `real`, `double`,
  `varchar`/`string`, `char`, `text`, `boolean`, `date`, `time`, `datetime`,
  `timestamp`, `blob`→`Uint8Array`, `json<T>`/`jsonb<T>`, `uuid`, `enum`→literal
  union). Modifiers `.primaryKey()`, `.notNull()`, `.default()`, `.onUpdate()`.
  Types inferred by `InferModel` (SELECT) and `InferInsert` (insert).
- **Portable defaults** (`sql.now()`, `sql.uuidv4()`, etc.), stored on the column for
  the migration IR.
- **`parseDatabaseUrl`/`detectDialect`** — database identified via URL (à la
  `make_url`).
- **Serialization** (`toDict`/`toJSON`/`stringify`/`fromDict`/`parse`) with
  per-column-type coercion.
- **Phase 3 — operators typed per column type** (`OperatorsFor<T>`): `string`→
  `like`/`ilike`/`in`; `number`/`bigint`/`Date`→ordered+`between`; `boolean`→
  eq/`isNull`. An invalid combination = compile error.
- **Phase 4a — per-dialect SQL compilation**: `getDialect(...).compile(node)` →
  parameterized `{ sql, params }` (`?`/`$1`), SELECT/INSERT/UPDATE/DELETE +
  `RETURNING`; native `ilike` in Postgres.
- **Phase 4b — real execution**: `createEngine` (async) / `createSyncEngine` (SQLite
  sync), `Session.execute` with typed terminals, `engine.transaction` + savepoints,
  row coercion. SQLite via `node:sqlite`; PostgreSQL via `postgres.js`.
- **Phase 5 — typed joins**: `join(Model, alias).innerJoin/leftJoin(...)` →
  composite type `{ [alias]: Row }`, `leftJoin` nullable; typed `alias.column` refs.
- **Phase 6 — migrations** (`tempest-db-js/migrations`, Alembic-style): `reflectSchema`,
  `diffSchema`, typed operations + `invert`, `renderOperation` (per-dialect DDL),
  `generateMigration`, DAG graph (`topoOrder`/`heads`), `MigrationRunner`
  (real `upgrade`/`downgrade`). SQL only in the renderer.
- **Phase 7 — repository**: `BaseRepository<Model>` (typed CRUD + pagination) over
  `AsyncSession`, 404 convention (`RecordNotFound`/`[]`), `PaginationFilter`/
  `PaginationResult` aligned with `tempest-fastapi-sdk`.
- **Refinements**: `and`/`or`/`not` combinators in `where` (select/update/delete/
  join); SQLite batch-mode (`recreate_table`) for column changes preserving the data;
  SQLite introspection + `checkDrift` (compares the live DB with the models).
- **More refinements**: `session.stream(query)` (lazy sync/async iteration);
  `hasMany`/`belongsTo` relations + `loadRelations` (typed eager-loading, no N+1);
  migration CLI `runMigrationCli` (`upgrade`/`downgrade`/`check`/`revision
  --autogenerate`); structural PostgreSQL (introspection, named enum, `PoolOptions`).
- **Phase 2 — typed query builder (pure AST, no execution).**
    - `select(Model)` / `select(Model, [cols])` → full-row or `Pick` inference,
      with `.where()`, `.orderBy()`, `.limit()`, `.offset()`.
    - `insert(Model).values(...)` typed by `InferInsert`, with `.returning()`.
    - `update(Model)` / `del(Model)` with a **typed state guard**: the query only
      becomes executable after an explicit `.where(...)` or `.unguarded()` — an
      accidental full-table UPDATE/DELETE becomes a compile error.
    - `.returning(cols)` inferring a `Pick` projection on every mutation.
- Bilingual documentation (PT-BR + EN-US) in MkDocs Material, published on GitHub
  Pages.

### Notes

- Alpha (`v0.1.0`). The public surface may still change before `v1.0`.
- SQLite execution is real and tested (`node:sqlite`); PostgreSQL via `postgres.js`.
