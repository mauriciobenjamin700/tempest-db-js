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

## Partial unique index — the conflict-target predicate

On PostgreSQL, a **partial unique index** is only recognized as an `ON CONFLICT`
target when the query repeats the index predicate. Without it the database answers
`there is no unique or exclusion constraint matching the ON CONFLICT specification`.

```sql
CREATE UNIQUE INDEX outbound_idempotency_unique
    ON outbound_messages (consumer, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
```

```ts
insert(Outbound)
  .values(message)
  .onConflictDoNothing(["consumer", "idempotencyKey"], {
    where: { idempotencyKey: { isNull: false } },  // (1)!
  })
  .returning();
```

1. The same condition language as a normal `where` — no raw strings.

On `DO UPDATE` the two predicates are separate, because Postgres puts them in
different places of the clause:

```ts
insert(Outbound)
  .values(message)
  .onConflictDoUpdate(
    ["consumer", "idempotencyKey"],
    { status: "queued" },
    {
      indexWhere: { idempotencyKey: { isNull: false } },  // the index predicate
      updateWhere: { attempts: { lt: 5 } },               // filters which rows are rewritten
    },
  );
```

See the [durable queue recipe](queue.md) for the full use case.

## Portability

`ON CONFLICT` works identically on **SQLite** and **PostgreSQL** — the dialect
emits the same clause, predicate included. The `SET` values are parameterized
(bound after the row values), never interpolated.

!!! warning "MySQL"

    MySQL uses `ON DUPLICATE KEY UPDATE`, which has no conflict target. A plain
    upsert works; passing `where`/`indexWhere` throws an explicit error instead of
    emitting SQL that ignores the rule.

## Recap

- `.onConflictDoNothing(target)` → keep the existing row.
- `.onConflictDoUpdate(target, set)` → upsert: overwrite the given columns.
- `target` = the unique/PK constraint column(s).
- `{ where }` / `{ indexWhere }` repeat the predicate of a partial unique index —
  required on PostgreSQL for it to match as a conflict target.
- `{ updateWhere }` restricts which conflicting rows are actually rewritten.
- Combines with `.returning()`; portable across SQLite ↔ PostgreSQL (MySQL throws
  for the predicate).
