# Models

Every table in tempest-db-js is a **class** that extends `Model`. The class fields are
**columns**, created by the `column` factory. Let's model our first table: users.

## Step 1 — Declare the table

```ts
import { Model, column } from "tempest-db-js";

class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  age = column.integer().notNull();
  nickname = column.text();                  // no .notNull() → nullable
  createdAt = column.timestamp().default(new Date());
}
```

Three things to notice:

1. **`static tablename`** sets the table name in the database. It's `static`
   because it belongs to the table, not to a row.
2. **Each column is a value**, assigned to a field (`id = column.integer()`). That
   value carries both the SQL type (runtime) and the static type (inference).
3. **Modifiers chain**: `.primaryKey()`, `.notNull()`, `.default(...)`.

!!! info "Why `column.integer()` and not `id: number`?"

    TypeScript erases types at compile time — `id: number` wouldn't exist at
    runtime, so tempest-db-js would have no way to know that `id` is an `INTEGER`
    column. By making the column a **value** (`column.integer()`), the information
    survives at runtime **and** the static type is inferred from it. It's the core
    trick of tempest-db-js. See [Architecture](../architecture.md) for the background.

## Step 2 — The column types

The `column` factory covers a rich catalog of types, mirroring SQLAlchemy's
generic types. Each one is a **distinct SQL type** mapped to the right TS type:

| Builder | TS type | SQL type |
| --- | --- | --- |
| `column.smallInteger()` | `number` | `SMALLINT` |
| `column.integer()` | `number` | `INTEGER` |
| `column.bigInteger()` | `bigint` | `BIGINT` |
| `column.numeric(p, s)` / `column.decimal(p, s)` | `string` | `NUMERIC(p,s)` |
| `column.real()` | `number` | `REAL` |
| `column.double()` | `number` | `DOUBLE PRECISION` |
| `column.varchar(n)` / `column.string(n)` | `string` | `VARCHAR(n)` |
| `column.char(n)` | `string` | `CHAR(n)` |
| `column.text()` | `string` | `TEXT` |
| `column.boolean()` | `boolean` | `BOOLEAN` |
| `column.date()` | `Date` | `DATE` |
| `column.time({ timezone })` | `string` | `TIME` |
| `column.datetime({ timezone })` | `Date` | `DATETIME`/`TIMESTAMP` |
| `column.timestamp({ timezone })` | `Date` | `TIMESTAMP` |
| `column.blob()` | `Uint8Array` | `BLOB`/`BYTEA` |
| `column.json<T>()` | `T` | `JSON` |
| `column.jsonb<T>()` | `T` | `JSONB` |
| `column.uuid()` | `string` | `UUID` |
| `column.enum(...vals)` | literal union | `ENUM` |

!!! tip "`varchar` ≠ `text`, and why `bigint`/`numeric` are special"

    - `varchar(n)` is bounded (`VARCHAR(n)`); `text` is unbounded (`TEXT`) — distinct
      SQL types, just like in SQLAlchemy.
    - `bigInteger` maps to **`bigint`** (not `number`) to preserve 64 bits without
      losing precision.
    - `numeric`/`decimal` map to **`string`** — JS has no exact decimal, and
      stringifying preserves precision instead of throwing it into a float.
    - `enum("admin", "user")` infers the **literal union** `"admin" | "user"`.

And the modifiers that change the **inferred shape** or the behavior:

| Modifier | Effect |
| --- | --- |
| `.primaryKey()` | Marks it as the primary key (and implies a default). |
| `.notNull()` | Non-nullable column → the type drops the `| null`. |
| `.default(v)` | Default on insert → optional on insert. Accepts a value or a {@link sql} expression. |
| `.onUpdate(v)` | Reapplies the value on every UPDATE (e.g. `updated_at`). |

### Portable defaults (`sql`)

Beyond constant values, `.default()` accepts **portable expressions** from the
`sql` namespace — the dialect renders the right SQL (`CURRENT_TIMESTAMP` on SQLite,
`now()` on Postgres). It's the equivalent of SQLAlchemy's `func.now()`/`server_default`.

```ts
import { Model, column, sql } from "tempest-db-js";

class Post extends Model {
  static tablename = "posts";
  id = column.uuid().primaryKey().default(sql.uuidv4());     // generates the UUID in the DB
  title = column.varchar(120).notNull();
  views = column.integer().notNull().default(0);             // literal
  createdAt = column.datetime().notNull().default(sql.now());           // filled on insert
  updatedAt = column.datetime().notNull().default(sql.now()).onUpdate(sql.now()); // and on every update
}
```

Available expressions: `sql.now()`, `sql.currentDate()`, `sql.currentTime()`,
`sql.uuidv4()`, and `sql.raw("...")` (escape hatch). The default is **stored on the
column** (`column.createdAt.defaultValue`) — it's what feeds the migration IR in
Phase 6.

## Step 3 — Infer the row type (SELECT)

Here's the payoff. Use `InferModel` to extract the shape of a **read row**:

```ts
import { type InferModel } from "tempest-db-js";

type UserRow = InferModel<typeof User>;
// {
//   id: number;
//   name: string;
//   age: number;
//   nickname: string | null;   // nullable → becomes `| null`
//   createdAt: Date | null;
// }
```

Notice the nullability: `name` and `age` have `.notNull()`, so they are
`string`/`number`. `nickname` and `createdAt` don't — so tempest-db-js infers `| null`,
matching SQL semantics (a column without `NOT NULL` can hold `NULL`).

!!! check "No repetition"

    You didn't write any `interface User` by hand. The `UserRow` type **derives**
    from the class. Change a column and the type changes with it — schema and type
    never drift apart.

## Step 4 — Infer the insert type (INSERT)

Inserting is different from reading. A column is **optional** on insert when the
database knows what to do without you: it has a **default** (or is a primary
key), **or** it accepts `NULL`. Use `InferInsert`:

```ts
import { type InferInsert } from "tempest-db-js";

type UserInsert = InferInsert<typeof User>;
// {
//   name: string;              // required (notNull, no default)
//   age: number;               // required (notNull, no default)
//   id?: number;               // optional (PK)
//   createdAt?: Date | null;   // optional (has a default)
//   nickname?: string | null;  // optional (nullable → NULL is SQL's default)
// }
```

The only thing left required is what the database **cannot** fill in: a `notNull`
column with no default.

!!! tip "Nullable is optional because SQL already says so"

    Omitting a nullable column with no `DEFAULT` writes `NULL` — exactly what
    `nickname: null` would do. Requiring the hand-written `null` only adds noise
    that **reads like a deliberate decision to blank the column**, when it is
    just filling in a type. And a new column added by a migration would break
    every existing insert at compile time while having nothing to say about it.

    Passing `null` explicitly is still valid — be explicit if you want to be.

!!! warning "A multi-row insert shares one column list"

    One `INSERT` has one column list, so a key present in some rows and absent in
    others is written as `NULL` for the rows that omit it. For a nullable column
    that is the same as omitting it; for a column **with a default** it is not, so
    the builder refuses rather than writing `NULL` in place of the default:

    ```
    values: "tier" has a default but is missing from some rows of this
    multi-row insert — ...
    ```

    Give the column in every row, or insert them separately.

## Recap

- Table = a class `extends Model` with `static tablename`.
- Column = a **value** created by `column.*()`, with chainable modifiers.
- `.notNull()` controls the nullability of the inferred type.
- `InferModel<typeof T>` → the row shape for **reading**.
- `InferInsert<typeof T>` → the shape for **inserting**: PK, defaulted **and
  nullable** columns are optional; only `notNull` without a default is required.

With the model in place, let's query it. 👉 **[Queries](queries.md)**
