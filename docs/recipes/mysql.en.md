# MySQL: what changes

The third database in scope. Most of the builder behaves identically — this guide
is about the differences that do show up.

## Connecting

```ts
import { createEngine } from "tempest-db-js";

const engine = createEngine("mysql://app:secret@localhost:3306/app");
```

`mysql2` is an **optional** peer dependency, lazy-loaded on the first query:

```bash
npm install mysql2
```

`mariadb://` is recognized too and uses the same dialect.

## `RETURNING` — the round-trip

MySQL has no `RETURNING`. Even so, `.returning()` works on a **single-row
insert**: the session inserts and reads the row back by key, on the same
connection.

```ts
const created = await session
  .execute(insert(Task).values({ ownerName: "Ana", title: "ship" }).returning())
  .one();

created.id;  // filled in by AUTO_INCREMENT
```

That is what makes `BaseRepository.create()` and `activeRecord.save()` work on
MySQL.

How the key is chosen:

- **Client-supplied PK** (uuid, text) → read back by that value.
- **Auto-increment PK** → read back by `LAST_INSERT_ID()`.

!!! danger "`LAST_INSERT_ID()` is per connection"

    Outside a transaction the session **reserves** a pooled connection for the
    pair of statements; inside `transaction()` it is already pinned to one. Either
    way the insert and the read land on the same connection — and the read rolls
    back with the transaction.

!!! warning "A multi-row insert with `.returning()` is an error"

    `LAST_INSERT_ID()` identifies only the **first** row of a multi-row insert,
    and the rest are consecutive only under some `innodb_autoinc_lock_mode`
    settings. Rather than return possibly-wrong rows, the session throws:

    ```
    mysql has no RETURNING, and reading back a multi-row insert is not reliable —
    insert one row at a time, or drop .returning().
    ```

`UPDATE`/`DELETE` with `.returning()` have no cheap equivalent and still throw —
run a `SELECT` yourself.

## What MySQL cannot do

Each of these throws an **explicit error**, never degrading silently:

| Feature | Status on MySQL |
| --- | --- |
| `LIMIT`/`OFFSET` inside `IN (SELECT ...)` | Not supported by the server. Select the ids first, or wrap it in a derived table. |
| A conflict-target predicate ([upsert](upsert.md)) | `ON DUPLICATE KEY UPDATE` has no conflict target. |
| [`column.array()`](arrays.md) | No native array type. |
| CLI drift `check` | `information_schema` introspection is not implemented yet. |

## What works the same

- **`FOR UPDATE SKIP LOCKED`** (MySQL 8.0+) — the [durable queue](queue.md)
  pattern runs unchanged.
- **Expressions in writes** — `sql.raw("attempts + 1")`, `` sql.expr`` ``,
  `sql.now()`.
- **`ieq`** — `lower(col) = lower(?)`.
- **Subqueries in `IN`**, as long as there is no `LIMIT`.
- **`HAVING`** and `ORDER BY` by aggregate alias.
- **Plain upsert** via `ON DUPLICATE KEY UPDATE`.
- **[Column names](naming.md)** and the naming strategy.

## DDL differences

The renderer emits `INT`/`BIGINT`, `VARCHAR(n)`, `DATETIME`, `TINYINT(1)` for
boolean, `JSON`, `CHAR(36)` for uuid, a native `ENUM`, `AUTO_INCREMENT` for a lone
integer PK, `RENAME TABLE` and `MODIFY COLUMN`. Identifiers use backticks.

## Recap

- `mysql://` + `npm install mysql2`.
- `.returning()` works on a **single-row** insert via a same-connection read-back;
  multi-row and UPDATE/DELETE throw.
- A subquery with `LIMIT`, an `ON CONFLICT` predicate and `column.array()` throw
  explicit errors.
- Row locking, expressions, `ieq`, `HAVING` and plain upsert all work normally.
