# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adopts [Semantic Versioning](https://semver.org/).

## [Unreleased]

> Work cycle over issues #24–#51. The npm publish happens **once**, at the end of the
> cycle — every delivery lands here until then.

### ⚠️ Breaking

- **The 3rd parameter of `SyncSession`/`AsyncSession` changed from `QueryLogger` to
  `QueryHooks`** (`{ onQuery, onQueryEnd, slowQueryMs }`), and likewise for the
  `SyncEngine`/`AsyncEngine` constructors. Users of `createEngine`/`createSyncEngine`
  are unaffected; code constructing a session or engine by hand with a logger function
  passes `{ onQuery: logger }` instead (#29).

- **SQLite now enforces `FOREIGN KEY`.** Enforcement used to be off (SQLite's own
  per-connection default), so an orphan `INSERT` was accepted and `ON DELETE CASCADE`
  never fired. The engine now turns it on when any SQLite connection opens, on both
  drivers. A database that already holds an orphan row will start rejecting writes that
  touch it — which is the point. Escape hatch:
  `{ sqlite: { foreignKeys: false } }` (#24).

### Added

- **Backup and restore, from the CLI and programmatically** — `tempest-db backup <file>
  --url` and `tempest-db restore`, plus `backupDatabase`/`restoreDatabase`. PostgreSQL
  uses `pg_dump`/`pg_restore`/`psql` with the format picked **by the extension** (`.sql`
  plain, anything else custom), and the password travels in `PGPASSWORD` — never in
  `argv`, which any process on the machine can read. SQLite uses **`VACUUM INTO`**, not a
  file copy: with WAL on, the `.db` file alone is not the whole database, and
  `VACUUM INTO` is consistent even while another connection writes. The driver suffix
  (`postgresql+asyncpg`) is stripped before the tool is invoked, and a missing tool
  becomes `BackupToolMissing`. Both commands are dispatched **before** the migration
  config is loaded — a database that cannot be migrated yet is exactly the one needing a
  dump (#44).

- **Append-only audit trail** — `auditLogModel(table)` for the schema and
  `enableAudit(Model, { log, actor, exclude })` to turn it on. One entry per
  create/update/delete, with `rowKey` (a composite key in full), the action, an actor
  resolved **at write time**, and a `{ column: [before, after] }` diff carrying **only
  what changed** — an update with no delta writes nothing. Built on the signals (#36), so
  the entry is written on the same session and therefore in the change's own transaction:
  a rollback takes the entry with it, because a trail recording an uncommitted change is
  worse than no trail (#43).

- **`TenantScopedRepository`** — a repository bound to one tenant: the predicate joins
  **every** read and the column is stamped on **every** write, because `BaseRepository`'s
  methods now pass through a single scoping point (`scopeFilters` / `scopeWrite`,
  protected and overridable) instead of each one remembering the `WHERE`. Another
  tenant's row is "not found", not "forbidden" — telling them apart would already leak —
  and writing while naming another tenant **throws** rather than being silently
  overwritten. A model without the column makes the constructor throw (#42).

- **`engine.explain(fn)`** — captures the plan of **every** statement a block runs, with
  the parameters the code actually used (the block gets a recording session).
  `EXPLAIN (FORMAT JSON)` on PostgreSQL, `EXPLAIN QUERY PLAN` on SQLite, plus a readable
  `summary()` per plan. `analyze: true` **executes** the statement to measure it, so it is
  refused for writes — analyzing an `UPDATE` would apply it twice — and SQLite throws,
  since `EXPLAIN ANALYZE` does not exist there (#41).

- **Transactional outbox** — `outboxModel(table)` for the schema and `OutboxRepository`
  for the relay: `publish`, `pending`, `claim`, `markSent`, `markFailed` with backoff and
  permanent give-up. `claim` uses `FOR UPDATE SKIP LOCKED` over a subquery, so two
  concurrent relays take **disjoint** batches, and it increments `attempts` on the claim
  itself, which gives a dead-letter policy for free. `publish()` deliberately does **not**
  open its own transaction: atomicity comes from the re-entrant `transaction()`, with the
  business row and the event on the same session — a `saveWithOutbox` would be a second
  way to do the same thing (#40).

- **Set operations: `union`, `unionAll`, `intersect` and `except`** — they combine two or
  more SELECTs into a builder executable like any other, with **branch shapes checked at
  compile time** (the mistake the database only reports at runtime).
  `orderBy`/`limit`/`offset` apply to the set; a branch carrying its own ordering or limit
  is **parenthesized**, since otherwise those clauses would bind to the combined query —
  a different query. `INTERSECT`/`EXCEPT` throw on MySQL, by scope (#39).

- **`exists` / `notExists` and `scalar`** — correlated `EXISTS (...)`, the right shape
  when only existence matters (the database can stop at the first match, which an `IN`
  over a materialized set cannot), plus scalar subqueries as values. `scalar()` takes the
  result of `.asSubquery(column)`, so a two-column scalar subquery is a **compile** error
  instead of a runtime error in the database (#38).
- **`where` accepts an expression in the object form** — `{ userId: col("users.id") }`
  compares two columns, and so does `{ total: { gt: col("paid") } }`. An expression in
  that position used to be **bound as a parameter**: the comparison silently became the
  column against the string `"users.id"`. A qualified reference (`table.column`) now
  resolves to `"table"."column"` instead of becoming one identifier (#38).

- **`BaseRepository`: `existsExcluding`, `bulkUpsert`, `softDelete`/`restore`,
  `deleteBatch` and `changesSince`** — the operations every service rewrote on top of the
  builder. `changesSince` is the delta-sync read: a **strict** `updatedAt` filter, oldest
  first, tie-broken by primary key, and a `serverTime` read **before** the query as the
  watermark (using the newest `updatedAt` received would let a row committed mid-page
  fall into the gap between two pulls). A soft-deleted row comes back as a tombstone,
  which is what makes the client drop its local copy. `softDelete`/`restore`/`changesSince`
  throw naming the mixin when the model lacks the column (#37).
- **`sql.excluded(column)`** — references the incoming row of an upsert
  (`excluded."col"` on PostgreSQL/SQLite, `VALUES(col)` on MySQL). Without it an N-row
  upsert has no way to write the new value, since each row has its own (#37).

- **Repository signals** — `preSave`, `postSave`, `preDelete` and `postDelete` around
  `create`/`createMany`/`update`/`delete`, per row. A handler that throws on a `pre*`
  **vetoes** the write; the payload carries the **same session**, so a handler that
  writes commits (or rolls back) with the write it observed. `update`/`delete` take a
  filter rather than a row, so the extra read that hands the row to a handler only
  happens when one is registered (`hasHandlers`) — no usage, no cost. `clearSignals` for
  tests (#36).

- **Text search: `contains`, the `iContains` operator, `escapeLike`, `fullText` and
  `fullTextRank`** — the portable layer tokenizes the term and **escapes** every token,
  always emitting the `ESCAPE` clause (PostgreSQL assumes `\\` by default, **SQLite has
  no escape character at all** until one is declared). Before this, the `like`/`ilike`
  operand went through raw: searching for `100%` matched the whole table. The PostgreSQL
  layer uses `to_tsvector`/`websearch_to_tsquery`/`ts_rank` and, elsewhere, **compiles as
  `contains`** — the right rows without stemming, a documented degradation rather than
  an error. `escapeLike` existed only in `ilike`'s docstring; now it exists (#35).
- **`orderBy` accepts an expression** as well as a column name — without it there is no
  way to order by relevance (#35).

- **`parseIntegrityError`** — reads the driver's error back into the constraint that
  refused the write: `{ violation, constraint, table, columns, detail }`, or `null` when
  it is not an integrity violation. It is what separates `409 EMAIL_TAKEN` from a
  generic conflict without every service writing its own regex. It follows the `cause`
  chain (so `QueryExecutionError` is no obstacle), understands **both** ways SQLite
  reports a code (`node:sqlite` numeric, `better-sqlite3` named) and PostgreSQL's
  SQLSTATE plus `DETAIL:` line — where **all** the columns of a composite constraint
  come from. Pass the model and the names come back as properties instead of columns.
  MySQL returns `null`, by scope (#34).

- **`pool.prePing` and `pool.recycleMs`** — what was missing for a connection that dies
  without saying so (a failover, a pgbouncer restart, a firewall dropping an idle
  socket). `prePing` validates the connection with `SELECT 1` **before pinning it for a
  transaction**, which is where the damage is worst: `BEGIN` succeeds and the block dies
  halfway. `recycleMs` becomes postgres.js's `max_lifetime`. Both are PostgreSQL-only:
  on MySQL they **throw**, since mysql2 has no equivalent knob, and on SQLite the `pool`
  block does not apply (#33).

- **Per-transaction isolation level and read-only blocks** —
  `transaction(fn, { isolation, readOnly })`. PostgreSQL puts everything on the `BEGIN`
  itself; MySQL needs a `SET TRANSACTION` first and spells read-only on
  `START TRANSACTION`; SQLite implements only `serializable` and **throws** for any
  other level or for `readOnly`, rather than silently accepting a guarantee it cannot
  give. Requesting a characteristic on a nested block throws too: isolation is fixed
  when the transaction opens (#32).

- **`caseWhen` and `cast`** — `CASE WHEN ... THEN ... ELSE ... END` and
  `CAST(x AS type)` as first-class expressions. The `CASE` branches use the same `where`
  language, with no new grammar, and the `CAST` target is a portable vocabulary each
  dialect renders with the name it accepts (`integer` is `INTEGER` on PostgreSQL and
  SQLite, `SIGNED` on MySQL). Both used to require `sql.raw`, which loses the type
  (#31).
- **Aggregation over an expression** — `sum`/`avg`/`min`/`max` now take an expression as
  well as a column name, which is what makes conditional aggregation
  (`SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END)`) expressible: one pass over
  the table instead of a query per bucket (#31).

- **Re-entrant `transaction()`** — a nested block on the same session joins the outer
  one: one `BEGIN`, one `COMMIT`, and an inner failure rolls the whole thing back. It is
  what makes a service orchestrating several repositories work, since they all hold the
  same session. `session.transactionDepth` and `session.inTransaction` expose the state
  (#30).
- **`AsyncSession.beginNested`** — savepoints on the **async** path, which only existed
  on `SyncSession` even though the API reference documented `session.beginNested(fn)`
  unqualified. The async path is PostgreSQL's default, which is exactly where savepoints
  matter: recovering from a partial failure without dropping the whole transaction was
  impossible (#30).

- **`onQueryEnd` and `slowQueryMs` in `EngineOptions`** — the other half of `onQuery`,
  which fires **before** the statement and therefore cannot time anything. The new hook
  fires afterwards with `durationMs`, `rowCount` and — on the failure path — the
  driver's `error`: a slow statement that also fails is the interesting one.
  `slowQueryMs` filters by threshold, which gives a slow-query log with no APM agent.
  For `stream()`, the time spans until the iteration ends. An error thrown by the hook
  is swallowed, like the others (#29).

- **`BaseRepository.cursorPaginate`** — cursor pagination: `{ items, nextCursor }`,
  with no `COUNT(*)` and a boundary that stays stable under concurrent inserts, which
  is what offset paging cannot give on a large table. The **primary key is always
  appended as a tie-break** (a composite key in full), so a tie on `orderBy` cannot
  make a row fall between pages. The cursor is opaque and validated: corrupted, from
  another version, or produced under a different `orderBy` throws `InvalidCursor`
  instead of building the wrong `WHERE`. The comparison is written in expanded form
  (`a > v OR (a = v AND b > w)`) rather than as a row value, because tuple-comparison
  support varies across the databases (#27).
- **`encodeColumnValue` / `decodeColumnValue`** — the per-column codecs serialization
  already used, now exported: they are what lets a column value be stored outside the
  database (in a cursor, in a cache) and read back with the right type.

- **Model mixins** — `withTimestamps` (`createdAt`/`updatedAt`), `withSoftDelete`
  (`deletedAt`, plus `notDeleted()`/`onlyDeleted()` for `where`) and `withAudit`
  (`createdBy`/`updatedBy`, actor type configurable through a factory). They are
  functions taking the base class and returning the subclass, so they compose
  (`withAudit(withSoftDelete(withTimestamps(Model)))`) and contribute real columns: they
  appear in `InferModel`, in `InferInsert`, in the migration IR and in the DDL (#26).
- **`defaultAsWriteValue`** — converts a column's stored default (`DefaultValue`) into
  what the write path renders. It was the missing piece between the IR's shape and
  `set()`/`values()`.

- **`EngineOptions.sqlite`** — per-connection pragmas applied at open time:
  `foreignKeys` (defaults to `true`), `journalMode`, `busyTimeoutMs`, `synchronous`.
  Each one is **read back after it is written**, because SQLite answers a pragma it
  cannot honor by keeping the old value and saying nothing: `journalMode: "wal"` on a
  `:memory:` database now throws instead of pretending. Passing `sqlite` to a
  PostgreSQL/MySQL engine throws (#28).

### Fixed

- **Whether a statement returns rows was decided by an incomplete regex.** The
  `node:sqlite` path picks `all()` or `run()` before executing, and the test only covered
  `SELECT`/`PRAGMA` — so `EXPLAIN`, `WITH ... SELECT`, `VALUES` and `TABLE` were run as
  non-returning and reported **zero rows**, silently, instead of failing. better-sqlite3
  was unaffected (it asks the statement), which left the two drivers disagreeing (#41).

- **`sql.now()` wrote a format on SQLite that this package could not read back.**
  `CURRENT_TIMESTAMP` produces `"YYYY-MM-DD HH:MM:SS"` — no `T`, no milliseconds, no zone
  — and JS parses that as **local** time: a row written at 21:00Z read back as 00:00Z on
  a UTC-3 machine. Worse, comparing the column against a bound `Date` (ISO) compared
  `" "` against `"T"` and silently matched nothing. SQLite now renders
  `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, exactly the format this package binds and
  parses. It affects the DDL default and the `onUpdate` value; a database already written
  with the old format needs a conversion `UPDATE` (#37).

- **`Column.onUpdate()` is now applied.** The value was stored on the column and
  **never consumed** — not by the DDL, not by the builder — so `.onUpdate(sql.now())`
  did nothing, even though the `created_at / updated_at` recipe documented that "the
  value is re-applied on every UPDATE". `UpdateBuilder` now injects the value of every
  `onUpdate` column the `set()` does not mention. Applied on the write path, not in the
  schema: only MySQL has a column-level `ON UPDATE`, and rendering it into the DDL would
  make the same model diverge per database. An explicit value in `set()` still wins
  (#26).

- **A composite primary key is now honored in full** by `BaseRepository` and
  `activeRecord`. Both layers carried a copy of `primaryKeyOf` that returned the
  **first** `primaryKey()` column and moved on: `getById`, `update`, `delete`, `reload`
  and `save()`'s `ON CONFLICT` filtered on half the key and could read or write the
  wrong row. Resolution now lives in one place — `primaryKeysOf` and
  `primaryKeyFilter`, both exported — `getById` accepts `{ orderId, lineNumber }`, and a
  scalar for a composite key **throws** instead of matching half of it. A
  single-column key still takes the bare value (#25).

## [0.8.0] — 2026-09-05

`better-sqlite3` stopped being a promise: `EngineOptions.driver` and the
`sqlite+better-sqlite3` suffix now really select a driver.

### Added

- **`BetterSqliteDriver`** — a SQLite driver over the optional `better-sqlite3`
  peer dependency, exported from the public index, with the same prepared-statement
  cache as `NodeSqliteDriver`. Rows, coercion (`bigint`, `Date`, `boolean`, JSON),
  `RETURNING` and `stream()` are identical across both — swapping drivers does not
  change consumer code. The package is loaded **lazily**, like `postgres` and
  `mysql2`, and a missing install throws an error naming the `npm install`.
- **Real driver selection** — `{ driver: "better-sqlite3" }` and
  `sqlite+better-sqlite3:///app.db` open better-sqlite3; the option wins over the
  suffix when both appear. `node:sqlite` stays the default, with nothing to
  install. New recipe: *Choosing the SQLite driver*.

### ⚠️ Breaking

- **`EngineOptions.driver` now throws on an unknown name.** The field used to be
  silently ignored for any value, on any dialect — passing
  `{ driver: "better-sqlite3" }` ran on `node:sqlite` with no warning. Now
  `"sqlite3"` on SQLite, `"asyncpg"` on PostgreSQL and `"mysql3"` on MySQL fail
  when the engine is created. It is a runtime break only for code that was already
  being ignored, which is exactly the trap issue #22 recorded.
- The **URL suffix** stays forgiving on purpose: `sqlite+aiosqlite`,
  `postgresql+asyncpg` and friends are ignored, not rejected, so a URL copied from
  a Python service keeps connecting.

### Fixed

- **`EngineOptions.driver`, the `+better-sqlite3` suffix and the optional peer
  dependency were documented and ignored** (#22). `openSqliteDriver` never read
  `options.driver` or `parsed.driver`, and no line in `src/` ever loaded
  `better-sqlite3`. Anyone choosing the driver — for WAL, `pragma()`, a loadable
  extension, or because the rest of the service already used it — silently ran on
  another one.

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
