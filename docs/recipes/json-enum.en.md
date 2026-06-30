# JSON and enum columns

**Problem:** not every piece of data fits in a scalar column. You want to store an
**object** (preferences, metadata) or restrict a column to a **closed set of values**
(status, role) — and you want TypeScript to know the shape instead of handing you back an
`any` or a loose `string`.

**Solution:** `column.json<T>()` carries the type `T` of the parsed value; `column.enum(...)`
infers a **literal union** from the values you pass.

## Typed JSON

Pass the content type as a generic parameter — it propagates to reads and writes:

```ts
import { Model, column, type InferModel } from "tempest-db-js";

interface Prefs {
  theme: "light" | "dark";
  notifications: boolean;
}

class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  prefs = column.json<Prefs>().notNull();   // JSON → Prefs
}

type UserRow = InferModel<typeof User>;
// { id: number; name: string; prefs: Prefs }
```

On read, the value comes back already **parsed and typed**:

```ts
import { insert, select } from "tempest-db-js";

session.execute(insert(User).values({
  name: "Ann",
  prefs: { theme: "dark", notifications: true }, // checked against Prefs
}));

const [user] = session.execute(select(User)).all();
user.prefs.theme;          // "light" | "dark" — autocomplete works
// user.prefs.bogus;       // ❌ error: doesn't exist in Prefs
```

!!! tip "JSONB on PostgreSQL"

    Use `column.jsonb<T>()` to render `JSONB` (binary, indexable) on PostgreSQL.
    The API and the inference are identical — only the generated SQL type changes.

## Enum: literal union

`column.enum(...)` accepts the values as `const` arguments and infers the union:

```ts
class Ticket extends Model {
  static tablename = "tickets";
  id = column.integer().primaryKey();
  status = column.enum("open", "pending", "closed").notNull();
}

type TicketRow = InferModel<typeof Ticket>;
// { id: number; status: "open" | "pending" | "closed" }
```

The type blocks values outside the set **at compile time**:

```ts
session.execute(insert(Ticket).values({ status: "open" }));     // ✅
// session.execute(insert(Ticket).values({ status: "urgent" })); // ❌ won't compile

// and in the filter too:
session.execute(select(Ticket).where({ status: { in: ["open", "pending"] } })).all();
```

!!! info "Named enum on PostgreSQL"

    On SQLite the enum becomes a `TEXT` checked at the type level. On PostgreSQL, the
    migration generates a real named **`CREATE TYPE ... AS ENUM`**. Same model, idiomatic
    DDL per dialect.

## Coercion on serialization

`toJSON`/`fromDict` respect these types: JSON is serialized/parsed, and the enum is
validated as a string. See the [Reference](../reference.en.md#serialization).

## Recap

- `column.json<T>()` (or `jsonb<T>()`) carries the content type — typed reads and writes.
- `column.enum("a", "b")` infers the literal union `"a" | "b"`; an out-of-set value won't compile.
- Enum becomes a named `CREATE TYPE` on PostgreSQL; checked `TEXT` on SQLite.
