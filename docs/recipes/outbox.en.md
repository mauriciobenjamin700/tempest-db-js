# Transactional outbox

A handler that **writes a row** and **publishes an event** cannot do both safely as two
independent operations:

- die after the commit and before the publish → the event is lost;
- die after the publish and before the commit → a phantom event pointing at a row that
  never existed.

The outbox fixes it by writing the business row **and** an event row in the **same
transaction**. Either both commit or neither does. A separate relay reads what is pending
and publishes it; the broker can be down for minutes and the events wait in the table.

## The model

```ts
import { outboxModel } from "tempest-db-js";

class OutboxEvent extends outboxModel("outbox") {}
```

Columns: `id`, `topic`, `payload`, `status` (`pending`/`sending`/`sent`/`failed`),
`attempts`, `availableAt`, `createdAt`, `sentAt`, `lastError`.

## Writing (the handler's side)

```ts
await session.transaction(async () => {
  const order = await orders.create(data);
  await outbox.publish({ topic: "order.created", payload: { id: order.id } });
});
```

!!! info "Atomicity comes from `transaction()`, not from a new mechanism"

    `publish()` deliberately does **not** open its own transaction: both repositories use
    the same session, and `transaction()` is re-entrant. A `saveWithOutbox` method would
    be a second way to do the same thing.

## Publishing (the relay's side)

```ts
const batch = await session.transaction(async (tx) =>
  new OutboxRepository(OutboxEvent, tx).claim(50),
);

for (const event of batch) {
  try {
    await broker.publish(event.topic, event.payload);
    await outbox.markSent([event.id]);
  } catch (error) {
    await outbox.markFailed(event.id, error, { retryInMs: 30_000 });
  }
}
```

`claim` uses `FOR UPDATE SKIP LOCKED` over a subquery: two relays running at once take
**disjoint** batches instead of fighting over the same rows. The `attempts` counter is
incremented **on claim**, so a row carries its own history — which is what a dead-letter
policy reads.

!!! warning "`claim` does not exist on SQLite"

    SQLite has no row locking, so `forUpdate` throws there — the project's policy is an
    explicit error, not a silent fallback. In a single-process relay, use `pending()` and
    your own `update`.

!!! danger "Publishing is *at least once*"

    The relay can publish and die before `markSent`. The event goes out again on the next
    round. Consumers must be **idempotent** — that is a property of the pattern, not a
    limitation of this implementation.

!!! tip "Backoff and dead letters"

    `markFailed(id, error, { retryInMs })` returns the row to `pending` only after the
    delay; `{ permanent: true }` marks it `failed` and stops retrying. With `attempts` on
    the row, `WHERE attempts >= 10` is your dead-letter queue.

## Recap

- `outboxModel(table)` gives the schema; `OutboxRepository` gives the relay.
- Write the event and the business row in the same `transaction()`.
- `claim` → publish → `markSent`, or `markFailed` with backoff.
- Two concurrent relays take disjoint batches (PostgreSQL). 🚀
