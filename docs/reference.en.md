# API reference

Querium's public surface in Phases 1 and 2. Everything is imported from the package
level:

```ts
import {
  Model, column,
  type InferModel, type InferInsert,
  select, insert, update, del,
} from "querium";
```

!!! note "Living reference"

    This page covers what exists today (Phases 1-2). As new phases land (execution,
    typed operators, joins, migrations), the reference grows alongside. The source of
    truth is the docstrings in the code.

## Schema

### `Model`

Abstract base class for every table. Subclasses define `static tablename` and column
fields.

```ts
class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
}
```

### `column`

A factory for typed columns (mirrors SQLAlchemy's generic types).

| Method | TS type | SQL type |
| --- | --- | --- |
| `column.smallInteger()` | `number` | `SMALLINT` |
| `column.integer()` | `number` | `INTEGER` |
| `column.bigInteger()` | `bigint` | `BIGINT` |
| `column.numeric(p?, s?)` / `column.decimal(p?, s?)` | `string` | `NUMERIC(p,s)` |
| `column.real()` | `number` | `REAL` |
| `column.double()` | `number` | `DOUBLE PRECISION` |
| `column.varchar(n)` / `column.string(n)` | `string` | `VARCHAR(n)` |
| `column.char(n)` | `string` | `CHAR(n)` |
| `column.text()` | `string` | `TEXT` |
| `column.boolean()` | `boolean` | `BOOLEAN` |
| `column.date()` | `Date` | `DATE` |
| `column.time({ timezone? })` | `string` | `TIME` |
| `column.datetime({ timezone? })` | `Date` | `DATETIME`/`TIMESTAMP` |
| `column.timestamp({ timezone? })` | `Date` | `TIMESTAMP` |
| `column.blob()` | `Uint8Array` | `BLOB`/`BYTEA` |
| `column.json<T>()` | `T` | `JSON` |
| `column.jsonb<T>()` | `T` | `JSONB` |
| `column.uuid()` | `string` | `UUID` |
| `column.enum(...vals)` | literal union | `ENUM` |

Chainable modifiers (return a new `Column` with the flag applied):

| Modifier | Effect |
| --- | --- |
| `.primaryKey()` | Marks it as PK; implies `hasDefault`. |
| `.notNull()` | Makes the inferred type non-nullable. |
| `.default(value)` | Default on insert (a `T` value or an `sql` expression); marks it optional on insert. |
| `.onUpdate(value)` | Reapplied on every UPDATE (e.g. `updated_at`). |

### `sql` — portable defaults

Server-side expressions, rendered per dialect (à la SQLAlchemy's `func`):

| Function | Render | Use |
| --- | --- | --- |
| `sql.now()` | `CURRENT_TIMESTAMP` / `now()` | `created_at`/`updated_at` |
| `sql.currentDate()` | `CURRENT_DATE` | creation date |
| `sql.currentTime()` | `CURRENT_TIME` | time |
| `sql.uuidv4()` | `gen_random_uuid()` / fallback | UUID PK |
| `sql.raw(expr)` | verbatim | escape hatch |

The default is stored in `column.<field>.defaultValue` / `.onUpdateValue` — it feeds
the migration IR (Phase 6).

### `columnsOf(Model)`

Reflects the class into its `Column`s at runtime (`Record<string, Column>`). The base
of serialization and of the migrations schema reflector.

### `InferModel<typeof Model>`

The **read row** type. `notNull`/`primaryKey` columns are non-nullable; the rest
become `T | null`.

### `InferInsert<typeof Model>`

The **insert row** type. Columns with a default (or PK) are optional (`?`); the rest
are required.

## SELECT

### `select(Model)` / `select(Model, columns)`

| Form | Inferred result |
| --- | --- |
| `select(User)` | `InferModel<typeof User>[]` |
| `select(User, ["id", "name"])` | `Pick<InferModel<typeof User>, "id" \| "name">[]` |

### `SelectBuilder<Full, Proj>`

| Method | Description |
| --- | --- |
| `.where(input)` | Filters; keys typed against `Full`, operators typed per column. |
| `.orderBy(column, direction?)` | Orders by column (`"asc"` \| `"desc"`, default `"asc"`). |
| `.limit(n)` | Limits the number of rows. |
| `.offset(n)` | Skips the first `n` rows. |
| `.node` | The `SelectNode` AST (read-only). |

### `where` operators (`OperatorsFor<T>`)

Each `where` value accepts an exact match (shorthand for `eq`) or an operator object
restricted to the column's type:

| Type | Allowed operators |
| --- | --- |
| `string` | `eq`, `ne`, `in`, `notIn`, `like`, `ilike`, `isNull` |
| `number` / `bigint` / `Date` | `eq`, `ne`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `between`, `isNull` |
| `boolean` | `eq`, `ne`, `isNull` |
| json / blob | `eq`, `ne`, `in`, `notIn`, `isNull` |

`OPERATORS` (runtime) and the `Operator` type list the full set. An operator that's
invalid for the type = compile error.

#### `and` / `or` / `not` combinators

The object form is an implicit AND. For composite logic, use the combinators (in
select/update/delete/join):

| Symbol | Does |
| --- | --- |
| `and(...args)` | `(...) AND (...)` |
| `or(...args)` | `(...) OR (...)` |
| `not(arg)` | `NOT (...)` |

Each `arg` is the object form (`{ col: ... }`) or another combinator. Pass the row
type (`or<UserRow>(...)`) for key-safety inside the combinator.

## INSERT

### `insert(Model)`

Returns `InsertBuilder`.

| Method | Description |
| --- | --- |
| `.values(row \| rows)` | Typed by `InferInsert<typeof Model>`. Accepts 1 or N. |
| `.returning()` | Result becomes the full row. |
| `.returning(columns)` | Result becomes a `Pick` of the columns. |

Without `returning`, the execution result is `number` (affected rows).

## UPDATE

### `update(Model)`

Returns `UpdateBuilder<Full, false>` (unguarded).

| Method | Description |
| --- | --- |
| `.set(values)` | `Partial<Full>` — only the columns you pass get changed. |
| `.where(input)` | Filters **and** marks `Guarded = true`. |
| `.unguarded()` | Explicit opt-in to update all rows (`Guarded = true`). |
| `.returning()` / `.returning(cols)` | As in insert. |

## DELETE

### `del(Model)`

Returns `DeleteBuilder<Full, false>` (`del` because `delete` is reserved).

| Method | Description |
| --- | --- |
| `.where(input)` | Filters **and** marks `Guarded = true`. |
| `.unguarded()` | Explicit opt-in to delete all rows. |
| `.returning()` / `.returning(cols)` | As in insert. |

## AST types

Exposed for tooling and dialects (Phase 4): `SelectNode`, `InsertNode`,
`UpdateNode`, `DeleteNode`, `OrderTerm`, `SortDirection`, `WhereInput`, `Returning`.

## Database URL

### `parseDatabaseUrl(url)`

Parses a connection string and identifies the dialect, just like SQLAlchemy's
`make_url`. Accepts (and ignores) an async driver suffix (`+asyncpg`, `+aiosqlite`).

```ts
import { parseDatabaseUrl, detectDialect } from "querium";

parseDatabaseUrl("postgresql://app:secret@localhost:5432/mydb");
// { dialect: "postgresql", host: "localhost", port: 5432, user: "app",
//   password: "secret", database: "mydb", driver: null, options: {}, raw: "..." }

parseDatabaseUrl("sqlite:///app.db");      // { dialect: "sqlite", database: "app.db", ... }
detectDialect("sqlite://:memory:");        // "sqlite"
```

| Symbol | Description |
| --- | --- |
| `parseDatabaseUrl(url)` | `ParsedDatabaseUrl` (dialect + connection parts). |
| `detectDialect(url)` | Just the `Dialect` (`"sqlite" \| "postgresql"`). |
| `ParsedDatabaseUrl` | The result type. |
| `InvalidDatabaseUrl` | Error thrown on a URL with no scheme or an unknown dialect. |

## Serialization

Converts between a row (native values), a dict, and JSON, with per-column-type
coercion — à la Pydantic's `model_dump` / `model_validate`.

```ts
import { toDict, toJSON, stringify, fromDict, parse } from "querium";

toJSON(User, row);        // { ...JSON-safe: Date→ISO, bigint→string, blob→base64 }
toDict(User, row);        // { ...native, known columns only }
stringify(User, row);     // JSON string
fromDict(User, payload);  // validated row (coerces string→Date/bigint/Uint8Array; JSON.parse)
parse(User, jsonString);  // fromDict(JSON.parse(...))
```

| Function | Does |
| --- | --- |
| `toDict(Model, row)` | Dict of native values, restricted to the columns. |
| `toJSON(Model, row)` | JSON-safe object (`Date`→ISO, `bigint`→string, `Uint8Array`→base64). |
| `stringify(Model, row)` | `JSON.stringify(toJSON(...))`. |
| `fromDict(Model, data)` | Validated row from a dict; coerces types; validates required ones. |
| `parse(Model, json)` | `fromDict(Model, JSON.parse(json))`. |
| `ValidationError` | Thrown when a required column is missing. |

## SQL compilation (dialects)

A builder's AST becomes **parameterized** SQL via a dialect — the only place where
SQL is born. Always placeholders (`?` in SQLite, `$1` in Postgres), never
interpolation (injection-safe by construction). It does not execute — execution is
Phase 4b.

```ts
import { getDialect, select, Model, column } from "querium";

const sqlite = getDialect("sqlite");
const compiled = sqlite.compile(
  select(User).where({ age: { gte: 18 } }).orderBy("name").limit(10).node,
);
// { sql: 'SELECT * FROM "users" WHERE "age" >= ? ORDER BY "name" ASC LIMIT ?',
//   params: [18, 10] }
```

| Symbol | Description |
| --- | --- |
| `getDialect("sqlite" \| "postgresql")` | A dialect instance. |
| `BaseDialect.compile(node)` | `CompiledQuery` (`{ sql, params }`). |
| `SqliteDialect` / `PostgresDialect` | Concrete implementations. |
| `CompiledQuery` | `{ sql: string; params: readonly unknown[] }`. |
| `QueryNode` | The union of compilable ASTs. |

Differences per dialect: placeholder (`?` vs `$1`) and `ilike` (native `ILIKE` in
Postgres; `LIKE` in SQLite, case-insensitive in ASCII).

## Execution (engine / session)

Database identified by URL; execution **async by default**, sync optional for SQLite.

| Symbol | Description |
| --- | --- |
| `createEngine(url, opts?)` | `AsyncEngine` (SQLite or PostgreSQL). |
| `createSyncEngine(url, opts?)` | `SyncEngine` (SQLite; throws on Postgres). |
| `engine.session()` | Opens a `Session`/`SyncSession`. |
| `engine.transaction(fn)` | Transactional block (automatic commit/rollback). |
| `engine.close()` | Closes the driver. |
| `session.execute(builder)` | Runs and coerces; returns a `Result`. |
| `session.stream(builder)` | Lazy iteration (sync: `Iterable`; async: `AsyncIterable`). |
| `session.beginNested(fn)` | Savepoint (nested transaction). |
| `createEngine(url, { pool })` | `PoolOptions` (`size`/`idleTimeoutMs`/`connectTimeoutMs`) — PostgreSQL. |

`Result` terminals (async ones return a `Promise`):

| Terminal | Returns |
| --- | --- |
| `.all()` | `Row[]` |
| `.first()` | `Row \| null` |
| `.one()` | `Row` (error `NoResultError` if ≠ 1) |
| `.oneOrNull()` | `Row \| null` (error if > 1) |
| `.scalar()` | value of the 1st column `\| null` |
| `.scalars()` | values of the 1st column `[]` |
| `.rowsAffected()` | `number` |

Drivers: SQLite via the built-in `node:sqlite` (`NodeSqliteDriver`); PostgreSQL via
`postgres.js` (lazy). The `update`/`del` guard is required by `execute` (the
`Executable` type).

## Joins

| Symbol | Description |
| --- | --- |
| `join(Model, alias)` | Starts a `JoinBuilder<{ [alias]: Row }>`. |
| `.innerJoin(Model, alias, on)` | Inner join; adds `{ [alias]: Row }`. |
| `.leftJoin(Model, alias, on)` | Left join; adds `{ [alias]: Row \| null }`. |
| `.where(input)` | Filters by typed `alias.column` refs. |
| `.orderBy(ref, dir?)` / `.limit(n)` / `.offset(n)` | As in `select`. |

`on` maps refs of existing sources to refs of the new table (equality):
`{ "user.id": "order.userId" }`. The result is one object per alias, coerced per
model; `leftJoin` produces `null` when there's no match.

## Relations

| Symbol | Does |
| --- | --- |
| `hasMany(() => Target, { localKey, foreignKey })` | 1-N relation. |
| `belongsTo(() => Target, { localKey, foreignKey })` | N-1 relation. |
| `loadRelations(session, rows, spec)` | Eager-load (1 query/relation); typed result. |

`hasMany` → `Row[]`; `belongsTo` → `Row | null`.

## Migrations (`querium/migrations`)

| Symbol | Does |
| --- | --- |
| `reflectSchema(models)` / `reflectTable(model)` | Model → Schema IR. |
| `diffSchema(current, target)` | IR × IR → `Operation[]`. |
| `invert` / `invertAll` | Inverse of operations (for `down()`). |
| `renderOperation(op, dialect)` | Operation → SQL. |
| `generateMigration(draft)` | Codegen of a TS file. |
| `topoOrder` / `heads` | DAG ordering + tips. |
| `MigrationRunner` / `Op` | Applies/reverts; version table. |
| `replaySchema(migrations)` | "Current" IR without a database. |
| `introspectSqlite` / `checkDrift` | Live schema + drift (SQLite). |
| `introspectPostgres` / `checkDriftPostgres` | Same (PostgreSQL, structural). |
| `runMigrationCli(argv, config)` | CLI: `upgrade`/`downgrade`/`check`/`revision`... |
