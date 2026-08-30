# A durable queue on PostgreSQL

Several workers competing for the same rows, each claiming a batch without
blocking the others and without processing a row twice.

## The problem

The *outbox* / *job queue* pattern on Postgres is the same in every service: a
table of pending messages, N workers, and the golden rule that **one row is
processed by exactly one worker**.

Doing it naively fails in three distinct ways:

1. `SELECT ... WHERE status = 'queued' LIMIT 10` — two workers read the same
   batch and the message goes out twice.
2. Reading `attempts`, adding 1 in JavaScript and writing it back — two workers
   read `3`, both write `4`, and one attempt vanishes from the count.
3. Re-inserting the same message with the same idempotency key — a duplicate.

All three have an answer in SQL, and all three are expressible in the builder.

## The model

```ts
import { Model, column } from "tempest-db-js";

class Outbound extends Model {
  static tablename = "outbound_messages";
  static naming = "snake_case";

  id = column.uuid().primaryKey();
  consumer = column.text().notNull();
  idempotencyKey = column.text();
  status = column.enum("queued", "sending", "sent", "failed").notNull();
  attempts = column.integer().notNull().default(0);
  nextAttemptAt = column.datetime().notNull();
  updatedAt = column.datetime();
}
```

`static naming = "snake_case"` keeps the schema in `snake_case` (the SQL
convention) without contaminating TypeScript — see [Column names](naming.md).

## 1. Claim a batch — `FOR UPDATE SKIP LOCKED`

```ts
import { createEngine, select, update, sql } from "tempest-db-js";

const engine = createEngine("postgresql://app@localhost/app");

async function claimBatch(size: number): Promise<string[]> {
  return engine.transaction(async (tx) => {
    const rows = await tx
      .execute(
        select(Outbound, ["id"])
          .where({ status: "queued" })
          .orderBy("nextAttemptAt")
          .limit(size)
          .forUpdate({ skipLocked: true }),  // (1)!
      )
      .all();

    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return [];

    await tx
      .execute(
        update(Outbound)
          .set({
            status: "sending",
            attempts: sql.raw("attempts + 1"),  // (2)!
            updatedAt: sql.now(),
          })
          .where({ id: { in: ids } }),
      )
      .rowsAffected();

    return ids;
  });
}
```

1. `SKIP LOCKED` makes the second worker **skip** the rows the first already
   locked instead of waiting for them. Without it, workers either serialize
   (slow) or grab the same rows (duplicates).
2. The increment happens **in the database**. No `attempts` value travels to Node
   and back, so there is no window for another transaction to overwrite it.

### In a single query

With a subquery in `IN`, the `SELECT` and the `UPDATE` collapse into one
statement — one round trip instead of two, and no ids materialized in Node:

```ts
const claimed = await session
  .execute(
    update(Outbound)
      .set({
        status: "sending",
        attempts: sql.raw("attempts + 1"),
        updatedAt: sql.now(),
      })
      .where({
        id: {
          in: select(Outbound)
            .where({ status: "queued" })
            .orderBy("nextAttemptAt")
            .limit(10)
            .forUpdate({ skipLocked: true })
            .asSubquery("id"),          // (1)!
        },
      })
      .returning(),
  )
  .all();
```

1. `.asSubquery(column)` projects a single column and marks the `SELECT` as an
   `in`/`notIn` operand. The lock, the `ORDER BY` and the `LIMIT` travel with it,
   inside the outer statement.

!!! warning "On MySQL the subquery cannot carry a `LIMIT`"

    The server rejects `LIMIT` inside `IN (SELECT ...)`. The dialect throws at
    compile time and names the way out — there, use the two-step version above.
    See [MySQL: what changes](mysql.md).

!!! danger "The lock needs a transaction"

    `FOR UPDATE` only holds while the transaction is open. Outside a
    `transaction()` the lock is released immediately and you gained nothing. The
    `SELECT` and the `UPDATE` above are in the **same** `tx` on purpose.

!!! warning "SQLite has no row-level locking"

    `forUpdate()` throws an explicit error on the SQLite dialect. That is
    deliberate: a lock that does not exist is worse than an error, because the bug
    only shows up under production concurrency. On SQLite, serialize the claim
    inside a transaction — the write is already exclusive there.

`.forUpdate()` also takes `{ noWait: true }` (fail immediately instead of waiting)
and `{ of: ["table"] }` (restrict the lock to one table of a join). The weaker
sibling is `.forShare()`.

## 2. Idempotency — a **partial** unique index

The rule: a consumer repeating the same send with the same `Idempotency-Key` must
not duplicate the message; rows **without** a key are never deduplicated.

```sql
CREATE UNIQUE INDEX outbound_idempotency_unique
    ON outbound_messages (consumer, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
```

PostgreSQL only recognizes a partial index as an `ON CONFLICT` target when the
query **repeats the index predicate**. That is what the third argument is for:

```ts
import { insert } from "tempest-db-js";

const inserted = await session
  .execute(
    insert(Outbound)
      .values(message)
      .onConflictDoNothing(["consumer", "idempotencyKey"], {
        where: { idempotencyKey: { isNull: false } },  // (1)!
      })
      .returning(),
  )
  .all();

if (inserted.length === 0) {
  // It already existed: an idempotent repeat, nothing to do.
}
```

1. The predicate uses the **same condition language** as a normal `where` — no
   raw strings. Without it Postgres answers
   `there is no unique or exclusion constraint matching the ON CONFLICT specification`.

`onConflictDoUpdate` takes the two predicates separately, because in Postgres they
sit in different places of the clause:

```ts
insert(Outbound)
  .values(message)
  .onConflictDoUpdate(
    ["consumer", "idempotencyKey"],
    { status: "queued", nextAttemptAt: retryAt },
    {
      indexWhere: { idempotencyKey: { isNull: false } },  // the index predicate
      updateWhere: { attempts: { lt: 5 } },               // only rewrite rows that may retry
    },
  );
```

!!! info "Portability"

    The conflict-target predicate works on **PostgreSQL** and **SQLite**. MySQL
    uses `ON DUPLICATE KEY UPDATE`, which has no conflict target — the dialect
    throws an explicit error instead of emitting SQL that ignores the rule.

## 3. Counters without a race — expressions in `set`

`sql.raw()` writes a literal SQL expression; `` sql.expr`` `` writes a
**parameterized** one, with each `${...}` becoming a bound parameter:

```ts
update(Outbound)
  .set({
    attempts: sql.raw("attempts + 1"),                 // verbatim SQL
    nextAttemptAt: sql.expr`now() + ${backoff} * interval '1 second'`,
    updatedAt: sql.now(),                              // portable token
  })
  .where({ id });
```

!!! danger "A stray object in `set` now fails loudly"

    Before v0.5.0, `set({ attempts: { raw: "attempts + 1" } })` was **bound as a
    parameter** and wrote garbage into the column, with no error. Today any value
    that is neither a scalar nor a branded expression raises `ValidationError`
    while the query is being built. If you want an expression, use `sql.raw()` /
    `` sql.expr`` ``.

## The complete worker

```ts
async function drain(): Promise<void> {
  const ids = await claimBatch(10);
  for (const id of ids) {
    try {
      await deliver(id);
      await session
        .execute(
          update(Outbound)
            .set({ status: "sent", updatedAt: sql.now() })
            .where({ id }),
        )
        .rowsAffected();
    } catch {
      await session
        .execute(
          update(Outbound)
            .set({
              status: "queued",
              nextAttemptAt: sql.expr`now() + ${backoffSeconds} * interval '1 second'`,
            })
            .where({ id }),
        )
        .rowsAffected();
    }
  }
}
```

## Recap

- `.forUpdate({ skipLocked: true })` inside a `transaction()` → every worker takes
  a disjoint batch. `noWait` and `of` are available too; `forShare()` is the read
  version.
- SQLite throws instead of pretending it locked something.
- `onConflictDoNothing(target, { where })` repeats the partial index predicate,
  which is what makes Postgres accept it as a conflict target.
- `sql.raw()` / `` sql.expr`` `` / `sql.now()` in `set` keep the increment in the
  database — no read-modify-write.
- An unbranded object in `set`/`values` is a `ValidationError`, not silent
  corruption.
- `.asSubquery(column)` in `in` closes the claim in a single query (except on
  MySQL, which rejects `LIMIT` in a subquery).
