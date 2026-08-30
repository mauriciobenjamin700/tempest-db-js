# API reference

tempest-db-js's complete public surface. The core is imported from the package level;
migrations live under the `tempest-db-js/migrations` subpath:

```ts
import {
  Model, column, sql,
  type InferModel, type InferInsert,
  select, insert, update, del,
  and, or, not,
  createEngine, createSyncEngine,
  join, hasMany, belongsTo, loadRelations,
  BaseRepository,
} from "tempest-db-js";

import { reflectSchema, diffSchema, MigrationRunner } from "tempest-db-js/migrations";
```

!!! note "Living reference"

    This page summarizes the entire current public surface. The **source of truth**
    is the JSDoc docstrings in the code — the editor shows the full signature of each
    symbol in autocomplete.

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
| `column.array(element)` | `T[]` | `TEXT[]` / `INTEGER[]` (PostgreSQL) |
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
| `` sql.expr`...${v}` `` | parameterized fragment | expression with a bound value |

The default is stored in `column.<field>.defaultValue` / `.onUpdateValue` — it feeds
the migration IR.

Every `sql.*` expression is **branded** (`isSqlExpression`) and works both as a
column default and as a write value in `.set()` / `.values()`, where it is rendered
inline instead of being bound as a parameter:

```ts
update(Outbound)
  .set({ attempts: sql.raw("attempts + 1"), updatedAt: sql.now() })
  .where({ id });
```

!!! warning "`sql.expr` cannot be a column default"

    A `DEFAULT` has nowhere to bind parameters — `.default(sql.expr\`...\`)` throws
    immediately. Use `sql.raw()` there.

### Column names

| Symbol | Does |
| --- | --- |
| `.name("column")` | Maps the property to a different column name. |
| `static naming` | `"preserve"` (default) or `"snake_case"` for the whole table. |
| `columnNamesOf(Model)` | Property → column map, or `null` when nothing is renamed. |
| `columnPropsOf(Model)` | The inverse map, column → property. |
| `toSnakeCase(name)` | The conversion used by the `"snake_case"` strategy. |

See the [Column names](recipes/naming.md) recipe.

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
| `.forUpdate(options?)` | `FOR UPDATE [OF ...] [SKIP LOCKED \| NOWAIT]`. PostgreSQL/MySQL; SQLite throws. |
| `.forShare(options?)` | Same, with a shared lock (`FOR SHARE`). |
| `.aggregate(groupBy, spec)` | Groups; the builder then accepts `.having()`. |
| `.having(input)` | `HAVING`, by aggregate alias or grouped column. Only after `.aggregate()`. |
| `.asSubquery(column)` | Projects one column and marks the SELECT as an `in`/`notIn` operand. |
| `.node` | The `SelectNode` AST (read-only). |

`LockOptions` = `{ skipLocked?: boolean; noWait?: boolean; of?: readonly string[] }`.
`skipLocked` and `noWait` are mutually exclusive, and a lock combined with
`DISTINCT`/an aggregate throws at compile time.

### `where` operators (`OperatorsFor<T>`)

Each `where` value accepts an exact match (shorthand for `eq`) or an operator object
restricted to the column's type:

| Type | Allowed operators |
| --- | --- |
| `string` | `eq`, `ne`, `in`, `notIn`, `like`, `ilike`, `ieq`, `isNull` |
| `number` / `bigint` / `Date` | `eq`, `ne`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `between`, `isNull` |
| `boolean` | `eq`, `ne`, `isNull` |
| `T[]` (array) | `eq`, `ne`, `in`, `notIn`, `contains`, `containedBy`, `overlaps`, `isNull` |
| json / blob | `eq`, `ne`, `in`, `notIn`, `isNull` |

!!! danger "`ilike` is a pattern, `ieq` is equality"

    `%` and `_` are wildcards in `like`/`ilike` — `{ ilike: "%" }` matches every
    row. For a case-insensitive lookup (login, e-mail) use `ieq`, which compiles to
    `lower(col) = lower($1)` and matches a functional index. See
    [Case-insensitive comparison](recipes/case-insensitive.md).

The array operators (`contains` → `@>`, `containedBy` → `<@`, `overlaps` → `&&`)
are native to PostgreSQL; the other dialects throw an explicit error.

`OPERATORS` (runtime) and the `Operator` type list the full set. An operator that's
invalid for the type = compile error.

#### Expressions: `col`, `val`, `fn`

To compare a column against a column, or apply a SQL function:

| Symbol | Does |
| --- | --- |
| `col<Row>("column")` | A column reference (the **property** name, checked against `Row`). |
| `val(x)` | A bound value — required inside `fn.*`, where a string means a column. |
| `fn.lower/upper/trim/length/abs/coalesce` | Functions portable across all 3 dialects. |
| `fn.call(name, ...args)` | Any function; the name is validated as an identifier and **interpolated**. |

The comparison methods (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`,
`ieq`, `in`, `notIn`, `between`, `isNull`) return a `Condition`. An operand that is
not an expression becomes a bound parameter; `in`/`between` **refuse** an
expression.

```ts
select(Order).where(col<OrderRow>("total").gt(col<OrderRow>("paid")));
select(User).where(fn.lower("email").eq(fn.lower(val(probe))));
```

Details in [Expressions in `where`](recipes/expressions.md).

#### Subqueries in `in` / `notIn`

`in`/`notIn` take a list **or** a single-column `Subquery`:

```ts
update(Outbound).set({ status: "sending" }).where({
  id: { in: select(Outbound).where({ status: "queued" }).asSubquery("id") },
});
```

The subquery carries its own name map and binds its parameters at the position it
appears. MySQL rejects `LIMIT` inside one (an explicit compile-time error).

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
| `.onConflictDoNothing(target, options?)` | `ON CONFLICT (target) [WHERE ...] DO NOTHING`. |
| `.onConflictDoUpdate(target, set, options?)` | Upsert, with optional `indexWhere`/`updateWhere`. |
| `.returning()` | Result becomes the full row. |
| `.returning(columns)` | Result becomes a `Pick` of the columns. |

Without `returning`, the execution result is `number` (affected rows).

`OnConflictOptions` = `{ where? }` (the predicate of a **partial** unique index —
required on PostgreSQL for it to match as a conflict target).
`OnConflictUpdateOptions` = `{ indexWhere?, updateWhere? }`. Both take the same
condition language as `where`. MySQL throws for any predicate.

Values in `.values()` and `.set()` accept the column's value **or** a `sql.*`
expression; any other object raises `ValidationError` while the query is built.

## UPDATE

### `update(Model)`

Returns `UpdateBuilder<Full, false>` (unguarded).

| Method | Description |
| --- | --- |
| `.set(values)` | `WritePatch<Full>` — only the columns you pass change; accepts a `sql.*` expression. |
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

Exposed for tooling and dialects: `SelectNode`, `InsertNode`,
`UpdateNode`, `DeleteNode`, `OrderTerm`, `SortDirection`, `WhereInput`, `Returning`,
`LockClause`, `LockOptions`, `OnConflict`, `OnConflictOptions`,
`OnConflictUpdateOptions`, `WriteValues`, `WritePatch`, `NameMap`, `SqlExpression`,
`ExprNode`, `Expression`, `Subquery`.

## Database URL

### `parseDatabaseUrl(url)`

Parses a connection string and identifies the dialect, just like SQLAlchemy's
`make_url`. Accepts (and ignores) an async driver suffix (`+asyncpg`, `+aiosqlite`).

```ts
import { parseDatabaseUrl, detectDialect } from "tempest-db-js";

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
import { toDict, toJSON, stringify, fromDict, parse } from "tempest-db-js";

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
interpolation (injection-safe by construction). `compile` only builds the SQL; the
session runs it (see **Execution** below).

```ts
import { getDialect, select, Model, column } from "tempest-db-js";

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

Differences per dialect: placeholder (`?` vs `$1`), `ilike` (native `ILIKE` in
Postgres; `LIKE` in SQLite, case-insensitive in ASCII), row locking (`FOR UPDATE` on
Postgres/MySQL, an error on SQLite), the `ON CONFLICT` predicate (Postgres/SQLite,
an error on MySQL) and native arrays (PostgreSQL only).

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
| `session.raw(sql, params?, opts?)` | Raw **parameterized** statement; same `Result`. `{ as: Model }` coerces rows. |
| `toAsyncDriver(driver)` | Adapts a sync **or** async driver to the async interface (used by the CLI). |
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

`session.raw` is the way out for the query the builder cannot yet express — it goes
through the same `onQuery`, the same `QueryExecutionError` and the transaction's
reserved connection. Never interpolate values into the string: they go in `params`.
See [Raw SQL at runtime](recipes/raw-sql.md).

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

## Migrations (`tempest-db-js/migrations`)

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
