# Active-record (opt-in)

Instance methods (`save`/`update`/`delete`/`reload`) on a row — when you prefer
that style.

!!! info "Opt-in, not the default"

    tempest-db-js's default return is a plain inferred **object** (a design
    decision). Active-record is an **explicit** layer on top — you use it when you
    want it, without changing the default behavior of any query.

## The basics

```ts
import { Model, column, activeRecord, createEngine, sql } from "tempest-db-js";

class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  age = column.integer().notNull();
  createdAt = column.datetime().notNull().default(sql.now());
}

const session = createEngine("sqlite:///app.db").session();
const users = activeRecord(User, session);

// Create (unsaved) → save
const u = users.create({ id: 1, name: "Ana", age: 30 });
await u.save();          // INSERT; u.data now holds the full row (RETURNING)

// Update
await u.update({ age: 31 });   // UPDATE ... WHERE id = 1; merged into u.data

// Reload from the database
await u.reload();        // re-fetch by PK; throws if gone

// Delete
await u.delete();        // DELETE ... WHERE id = 1 → rows affected
```

## `.data` is the plain row

The fields live on `.data` — a plain object, typed by `InferModel`:

```ts
u.data.name;   // string
u.data.age;    // number
```

No magic proxy: you read/write `.data` and the methods persist it. That keeps the
row honest with the rest of the library (the same shape a `select` returns).

## The manager

`activeRecord(Model, session)` returns a small factory:

| Method | What it does |
|---|---|
| `create(data)` | Build an **unsaved** AR from insert data. |
| `wrap(row)` | Wrap an **already-loaded** row as an AR. |
| `get(id)` | Fetch by PK and wrap, or `null` if absent. |

```ts
const found = await users.get(1);   // ActiveRecord<User> | null
if (found) await found.update({ age: 40 });
```

## `save()` upserts

`save()` inserts; if the PK already exists, it overwrites (via
`ON CONFLICT DO UPDATE`). Only the columns **present** in `.data` are overwritten
— an absent column is not set to `null` and won't clobber a DB-side default.

## When to use it

- **Use** it when the flow centers on one loaded entity (edit → save).
- **Prefer `BaseRepository`** for bulk CRUD/pagination and queries.
- **Prefer the pure builder** (`select`/`insert`/...) for complex queries.

## Recap

- `activeRecord(Model, session)` → `create`/`wrap`/`get`.
- `ActiveRecord`: `save` (upsert), `update`, `delete`, `reload`; fields on `.data`.
- Opt-in layer — the default plain-object return is unchanged.
