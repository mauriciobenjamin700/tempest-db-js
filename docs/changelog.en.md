# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adopts [Semantic Versioning](https://semver.org/).

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
