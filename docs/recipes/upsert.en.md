# Upsert (ON CONFLICT)

Insert, but resolve a unique-key conflict instead of throwing.

## The problem

You insert a row whose PK / unique column already exists. By default the database
rejects it. Often you want to either **ignore** it (keep the existing row) or
**overwrite** it (upsert). That's `ON CONFLICT`.

## DO NOTHING — ignore the conflict

```ts
import { Model, column, insert, createSyncEngine } from "tempest-db-js";

class Setting extends Model {
  static tablename = "settings";
  key = column.text().primaryKey();
  value = column.integer().notNull();
}

const session = createSyncEngine("sqlite:///app.db").session();

session.execute(
  insert(Setting).values({ key: "theme", value: 1 }).onConflictDoNothing(["key"]),
);
// If "theme" already exists, the new row is dropped — no error.
```

## DO UPDATE — overwrite (upsert)

```ts
session.execute(
  insert(Setting)
    .values({ key: "theme", value: 2 })
    .onConflictDoUpdate(["key"], { value: 2 }),
);
// If "theme" exists, set value = 2. Otherwise insert.
```

The first argument is the conflicting column(s) (a unique/PK constraint). The
second is what to overwrite on conflict.

!!! tip "Combine with RETURNING"

    `.returning()` works alongside — grab the final row (inserted or updated):

    ```ts
    const saved = session
      .execute(
        insert(Setting)
          .values({ key: "theme", value: 2 })
          .onConflictDoUpdate(["key"], { value: 2 })
          .returning(),
      )
      .one();
    ```

## Portability

`ON CONFLICT` works identically on **SQLite** and **PostgreSQL** — the dialect
emits the same clause. The `SET` values are parameterized (bound after the row
values), never interpolated.

## Recap

- `.onConflictDoNothing(target)` → keep the existing row.
- `.onConflictDoUpdate(target, set)` → upsert: overwrite the given columns.
- `target` = the unique/PK constraint column(s).
- Combines with `.returning()`; portable across SQLite ↔ PostgreSQL.
