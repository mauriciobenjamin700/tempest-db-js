# Recipes

The **recipes** solve one specific problem at a time — complete, copy-paste code,
with the theory of *why* right next to it. They are the practical complement to the
[Tutorial](../tutorial/index.en.md): the tutorial teaches you the concepts in order; the
recipes show you how to apply them in real day-to-day situations.

!!! tip "How to read this"

    Each recipe is independent — jump straight to what you need. They all assume you
    have already been through the [Tutorial](../tutorial/index.en.md) (models, queries, execution).

## Available

| Recipe | Solves |
| --- | --- |
| [Foreign keys & UNIQUE](constraints.en.md) | FK, column UNIQUE and table constraints (composite/named), SQLAlchemy-style. |
| [created_at / updated_at](timestamps.en.md) | Database-managed timestamps, without remembering to set them by hand. |
| [Model mixins](mixins.en.md) | `withTimestamps`, `withSoftDelete`, `withAudit` — the columns every table repeats, declared once. |
| [Typed pagination](pagination.en.md) | Paginated lists with total/pages, aligned with `tempest-fastapi-sdk`. |
| [Aggregations & DISTINCT](aggregations.en.md) | `count`/`sum`/`avg`/`min`/`max` + typed `GROUP BY` and `DISTINCT`. |
| [Upsert (ON CONFLICT)](upsert.en.md) | Insert resolving a key conflict: `DO NOTHING` or `DO UPDATE`. |
| [Active-record (opt-in)](active-record.en.md) | `save`/`update`/`delete`/`reload` methods on a row, when you prefer it. |
| [Logging & errors](logging.en.md) | See the SQL that runs (`onQuery`) and errors carrying the failing SQL/params. |
| [Integrity errors (409)](integrity-errors.en.md) | Read the driver's error back into the constraint that refused the write. |
| [Repository signals](signals.en.md) | `preSave`/`postSave`/`preDelete`/`postDelete` — react to writes without wrapping every call site. |
| [Audit trail](audit.en.md) | One entry per change, with a before/after diff, in the same transaction. |
| [Choosing the SQLite driver](sqlite-drivers.en.md) | `node:sqlite` (default) or `better-sqlite3`, via the engine option or the URL suffix. |
| [Transactions and savepoints](transactions.en.md) | Atomic operations with automatic commit/rollback and savepoints. |
| [JSON and enum columns](json-enum.en.md) | Store typed objects and literal unions with type safety. |
| [Serialization (row ↔ JSON)](serialization.en.md) | Convert rows to JSON and validate JSON back into a row. |
| [Connecting to PostgreSQL](postgres.en.md) | Swap SQLite for Postgres via the URL and tune the pool. |
| [A durable queue on PostgreSQL](queue.md) | `FOR UPDATE SKIP LOCKED`, atomic counters and idempotency via a partial index. |
| [Transactional outbox](outbox.en.md) | Business row and event in one commit; a relay taking disjoint batches. |
| [Column names](naming.md) | A `snake_case` schema behind a `camelCase` model, with no false drift. |
| [PostgreSQL array columns](arrays.md) | Typed `text[]`/`integer[]`, with `@>`, `<@` and `&&`. |
| [Case-insensitive comparison](case-insensitive.md) | `ieq` for case-insensitive login — and the `ilike` trap. |
| [Text search](text-search.md) | Escaped, portable `contains`; `fullText`/`fullTextRank` with stemming on PostgreSQL. |
| [Raw SQL at runtime](raw-sql.md) | `session.raw` for the query the builder cannot yet express. |
| [Expressions in `where`](expressions.md) | Column vs column and SQL functions, to match a functional index. |
| [Set operations](set-operations.en.md) | `UNION`, `UNION ALL`, `INTERSECT`, `EXCEPT` with branch shapes checked by the types. |
| [MySQL: what changes](mysql.md) | `RETURNING` via read-back, and what MySQL cannot do. |

## Looking for something bigger?

If you want to see it all put together in a project that runs, go to **[Examples](../examples/index.en.md)**:
a Todo CLI, a blog with relations, a REST API, and the complete migrations workflow.
