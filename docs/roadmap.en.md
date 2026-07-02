# Roadmap

tempest-db-js is built in phases, each shipping a testable slice. **Phases 0–9
are complete** and published in `v0.3.0`. What remains are the database
follow-ups, the `tempest-ts-sdk` package, and the path to `v1.0`.

| Phase | Theme | Status |
| --- | --- | --- |
| 0 | Toolchain + CI + type tests | ✅ Done |
| 1 | Declarative class-based schema + inference | ✅ Done |
| 2 | Typed query builder (SELECT/INSERT/UPDATE/DELETE) | ✅ Done |
| 3 | Operators typed per column type | ✅ Done |
| 4 | Dialects + real execution (`Session`) | ✅ + `.stream()`/pool/`using`/benchmark |
| 5 | Joins + composite types + relations | ✅ + relations + and/or/not + join operators |
| 6 | Migrations + CLI | ✅ + drift + SQLite batch + PG enum + rename + bin |
| 7 | Repository + aggregations/upsert + active-record + DX | ✅ Done |
| 8 | Async migrations (closes PostgreSQL) | ✅ `AsyncMigrationRunner` |
| 9 | MySQL dialect | ✅ `MysqlDialect` + DDL + `mysql2` driver |

## Supported databases — focus on 3

tempest-db-js targets **exactly three databases: SQLite, PostgreSQL and MySQL** —
and no others for now. All three have a dialect, execution and migrations.

| Database | Status |
| --- | --- |
| **SQLite** | ✅ Complete and tested (`node:sqlite`). |
| **PostgreSQL** | ✅ Real execution, transactions (reserved connection), `SERIAL`, named enum, introspection/drift — tested against a live Postgres in CI. **Sync and async** migrations (`AsyncMigrationRunner`). |
| **MySQL** | 🟢 Complete dialect (backticks, `ON DUPLICATE KEY UPDATE`, `AUTO_INCREMENT`, `MODIFY COLUMN`), `mysql2` driver (lazy). Compilation tested. Missing: execution in CI and `RETURNING` via `LAST_INSERT_ID`. |

## What already runs (v0.3.0)

Declarative models + inference, typed query builder (**aggregations**,
**`DISTINCT`**, **upsert** `ON CONFLICT`/`ON DUPLICATE KEY`), composite joins with
typed `where` operators, N+1-free relations, real SQLite+PostgreSQL execution, a
MySQL dialect, **sync + async** migrations with a `tempest-db` CLI (interactive
rename, drift, `--sql`), `BaseRepository` + pagination, **opt-in active-record**,
and DX (`QueryExecutionError` + `onQuery`). See [Recipes](recipes/index.en.md) and
[Examples](examples/index.en.md).

## Next steps

### Database follow-ups (short term)

- **MySQL in CI** — stand up a MySQL service in the workflow and run the execution
  tests (today only compilation is tested; execution is gated like Postgres was).
- **`RETURNING` on MySQL** — round-trip via `LAST_INSERT_ID()` + `SELECT`, so
  `repository.create` and `activeRecord.save` work on MySQL (the dialect currently
  throws on `.returning()`).
- **Async CLI** — wire `tempest-db` to `AsyncMigrationRunner` to run migrations via
  the CLI against Postgres/MySQL, not just SQLite.

### Phase 10 — `tempest-ts-sdk` (own repo)

A separate package (flat layout) consuming tempest-db-js, mirroring
`tempest-fastapi-sdk`: extended `BaseRepository`, env settings, an `AppException`
hierarchy, HTTP integration.

### Phase 11 — Advanced query API

`HAVING` on aggregations, subqueries (IN/EXISTS/scalar), an explicit prepared-query
API, optional unit-of-work/identity-map for active-record.

### Phase 12 — Towards `v1.0`

Freeze the public API, test coverage, complete docs, alpha exit criteria.

!!! info "Full details in the repository"

    The root `ROADMAP.md` has the detailed timeline, risks and per-phase design
    decisions.
