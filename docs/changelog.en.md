# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adopts [Semantic Versioning](https://semver.org/).

## [0.7.0] — 2026-08-30

Two fixes from the same real consumer (`zap-api`): the noise `InferInsert` forced
into every insert, and PostgreSQL `NOTICE` output polluting the service's stdout.

### ⚠️ Breaking

- **Nullable columns are now optional in `InferInsert`.** This loosens a type, so
  nothing that compiled stops compiling — but anyone deriving types from
  `InferInsert` and expecting nullables to be required will see the shape change
  (`nickname: string | null` → `nickname?: string | null`).
- **PostgreSQL `NOTICE` is no longer printed.** Without `onNotice` it is dropped;
  postgres.js used to print it through `console.log`. Anyone relying on that
  print needs to pass `onNotice`.

### Added

- **`onNotice` in `EngineOptions`** — receives server-side notices
  (`CREATE TABLE IF NOT EXISTS` on an existing table, `DROP ... IF EXISTS`), in
  the same spirit as `onQuery`, with a throwing logger swallowed. **The default is
  silence:** writing to the host process's stdout is the application's decision,
  not a library's — and the previous default broke the structured log of anything
  consuming stdout (Docker, Loki, CloudWatch) on every boot, since a migration
  runner is usually the first thing to run.
- **`driverOptions` in `EngineOptions`** — passed straight to the driver, applied
  **last** (winning over `pool` and `onNotice`), for what the typed surface does
  not model: postgres.js's `connection`/`types`/`transform`/`ssl`, mysql2's own
  settings, `node:sqlite`'s `readOnly`. Keeps every gap from becoming a feature
  request.

### Fixed

- **A nullable column without a default required `field: null` in every insert.**
  Omitting a column that accepts `NULL` and declares no `DEFAULT` writes `NULL` —
  the same thing passing `null` does. Requiring the hand-written `null` only added
  noise that **reads like a deliberate decision to blank the column**, and made
  every new column added by a migration break compilation at every insert call
  site. Now `notNull` without a default is the only thing required; an explicit
  `null` is still accepted.
- **A multi-row insert dropped keys absent from the first row.** The column list
  came from `values[0]`, so in `values([{ a }, { a, note: "x" }])` the `note`
  column was never named and the value vanished with no error. The list is now the
  **union** of every row's keys. It was unreachable while every row had to carry
  every key — and became reachable the moment nullable columns turned optional.
- **Rows that disagree about a defaulted column** now raise `ValidationError`. One
  `INSERT` has one column list, so the omitting row would get `NULL` instead of
  its default; SQLite has no `DEFAULT` keyword inside `VALUES`, so there is no
  portable per-row escape — failing loudly is the honest option.

### Known limitations

- `EngineOptions.driver` (`"better-sqlite3"`) remains **documented and
  unimplemented**: `openSqliteDriver` always uses `node:sqlite`. `driverOptions`
  covers driver options, not swapping the driver.

## [0.6.0] — 2026-08-30

Closes the five gaps left over from the previous cycle (#13–#17): the advanced
query API, MySQL for real, and the migration CLI beyond SQLite.

### ⚠️ Breaking

- **`runMigrationCli` is now `async`** and returns `Promise<CliResult>`.
  `CliConfig.driver` accepts `SyncDriver | AsyncDriver`. Callers of the function
  need `await`; the `tempest-db` binary is already updated.

  ```diff
  - const result = runMigrationCli(["upgrade"], config);
  + const result = await runMigrationCli(["upgrade"], config);
  ```

- **`SelectBuilder` gained a third type parameter** (`Grouped`, defaulting to
  `false`), which is what makes `.having()` unreachable before `.aggregate()`. An
  annotation of `SelectBuilder<Row, Proj>` now means "not grouped"; to accept
  both, write `SelectBuilder<Row, Proj, boolean>`.

### Added

- **Subqueries in `IN`/`NOT IN`** — `.asSubquery(column)` projects one column and
  marks the `SELECT` as an operand, so the queue's batch claim fits in a single
  query (`UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)`).
  The subquery carries its own name map and binds its parameters at the position
  it appears. MySQL rejects `LIMIT` in a subquery — an explicit compile-time
  error.
- **`HAVING`** — `.having(input)` after `.aggregate()`, with keys typed against
  the aliases + grouped columns. The compiler re-emits the **expression**
  (`COUNT(*) > $1`) because PostgreSQL does not accept an alias in `HAVING`;
  `.orderBy()` now accepts an aggregate alias, which every dialect does accept.
- **Expressions in `where`** — `col<Row>("column")`, `val(x)` and `fn.*`
  (`lower`/`upper`/`trim`/`length`/`abs`/`coalesce` portable, `fn.call` for the
  rest) make **column vs column** comparison and functional-index lookups
  expressible. A column reference goes through the name map and join
  qualification; an operand that is not an expression is still bound as a
  parameter.
- **`RETURNING` on MySQL** — `.returning()` works on a **single-row** insert: the
  session inserts and reads the row back by `LAST_INSERT_ID()` (or by the supplied
  PK) on the **same connection**, reserving one outside a transaction. That is
  what makes `BaseRepository.create()` and `activeRecord.save()` work on MySQL. A
  multi-row insert with `.returning()` throws, because `LAST_INSERT_ID()`
  identifies only the first row.
- **Async migration CLI** — `runMigrationCli` runs on `AsyncMigrationRunner` for
  every dialect, adapting the driver with `toAsyncDriver`. `check` routes by
  dialect through `checkDriftAsync` (new `introspectSqliteAsync`; PostgreSQL via
  `information_schema`; MySQL returns an explicit not-implemented message).
  **Migrating PostgreSQL through the CLI is unblocked.**
- **CI** — a `mysql` job with a real MySQL 8 service; the `postgres` job also runs
  the end-to-end CLI test. `mysql2` is declared as an optional peer dependency
  (the code already imported it dynamically, without declaring it).
- **Docs** — new bilingual recipes "Expressions in `where`" and "MySQL: what
  changes"; "A durable queue" gained the single-query version; "Aggregations"
  gained `HAVING`; "Migrations" gained the async/PostgreSQL flow.

### Fixed

- **`introspectSqlite` and the drift comparison** were factored so the sync and
  async paths share one implementation — a second copy would diverge from the
  first the next time a rule changes.
- **An `Expression` inside `in`/`between`** was serialized as a parameter instead
  of becoming SQL; it now raises while the query is built, on the same principle
  as the `set()` guard.

### Known limitations

- Subqueries only in `IN`/`NOT IN`; `EXISTS` and scalar subqueries are still out.
- MySQL introspection (`information_schema`) does not exist, so `check` cannot
  detect drift there.
- `col()`/`fn.*` check the column **name**, not the operand's type — comparing a
  text column against a numeric one compiles.

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
