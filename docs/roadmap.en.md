# Roadmap

tempest-db-js is built in phases, each shipping a testable slice. **Phases 0–11
are complete** and published in `v0.6.0`. What remains are the database
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
| 10 | Gaps from the first real consumer | ✅ Row locking, expressions in `set`, `session.raw`, naming, arrays, `ieq` |
| 11 | Advanced query API + MySQL and CLI | ✅ Subqueries in `IN`, `HAVING`, `col`/`fn`, MySQL `RETURNING`, async CLI |

## Supported databases — focus on 3

tempest-db-js targets **exactly three databases: SQLite, PostgreSQL and MySQL** —
and no others for now. All three have a dialect, execution and migrations.

| Database | Status |
| --- | --- |
| **SQLite** | ✅ Complete and tested (`node:sqlite`). |
| **PostgreSQL** | ✅ Real execution, transactions (reserved connection), `SERIAL`, named enum, introspection/drift — tested against a live Postgres in CI. **Sync and async** migrations (`AsyncMigrationRunner`). |
| **MySQL** | 🟢 Complete dialect (backticks, `ON DUPLICATE KEY UPDATE`, `AUTO_INCREMENT`, `MODIFY COLUMN`), `mysql2` driver (lazy). Compilation tested. Missing: execution in CI and `RETURNING` via `LAST_INSERT_ID`. |

## What already runs (v0.6.0)

Declarative models + inference (with **explicit column names** and a naming
strategy), a typed query builder (**aggregations**, **`DISTINCT`**, **upsert**
`ON CONFLICT`/`ON DUPLICATE KEY` with a **partial-index predicate**, **row
locking** via `FOR UPDATE SKIP LOCKED`, **SQL expressions in `set`**),
**PostgreSQL array columns** with `@>`/`<@`/`&&`, composite joins with typed
`where` operators, N+1-free relations, real SQLite+PostgreSQL execution, a MySQL
dialect, **sync + async** migrations with a `tempest-db` CLI (interactive rename,
drift, `--sql`), `BaseRepository` + pagination, **opt-in active-record**, the
**`session.raw`** escape hatch, **subqueries in `IN`**, **`HAVING`**,
**expressions in `where`** (`col`/`fn`), and DX (`QueryExecutionError` +
`onQuery`). See
[Recipes](recipes/index.en.md) and [Examples](examples/index.en.md).

## Next steps

### Database follow-ups (short term)

- **MySQL introspection** — read the schema via `information_schema`, so
  `tempest-db check` can detect drift on MySQL (today it returns "not
  implemented").
- **`EXISTS` and scalar subqueries** — `IN`/`NOT IN` already take a subquery; the
  rest does not.
- **Operand typing in `col()`/`fn.*`** — the column **name** is checked today, the
  operand's type is not.

### Phase 12 — `tempest-ts-sdk` (own repo)

A separate package (flat layout) consuming tempest-db-js, mirroring
`tempest-fastapi-sdk`: extended `BaseRepository`, env settings, an `AppException`
hierarchy, HTTP integration.

### Phase 13 — Query API: what is still missing

`EXISTS` and scalar subqueries, an explicit prepared-query API, optional
unit-of-work/identity-map for active-record.

### Phase 14 — Towards `v1.0`

Freeze the public API, test coverage, complete docs, alpha exit criteria.

!!! info "Full details in the repository"

    The root `ROADMAP.md` has the detailed timeline, risks and per-phase design
    decisions.
