# Audit trail

`withTimestamps` records **when** a row changed and `withAudit` records **who** touched
it last. Neither keeps the **history**: one entry per create, update and delete, with the
actor, the action and a before/after diff.

```ts
import { auditLogModel, enableAudit } from "tempest-db-js";

class AuditLog extends auditLogModel("audit_log") {}

enableAudit(Order, {
  log: AuditLog,
  actor: () => currentUser()?.id ?? null,   // (1)!
  exclude: ["passwordHash"],                // (2)!
});
```

1. Called **at write time**, so it can read request-scoped context.
2. Columns not worth recording — a hash, a large blob.

## What gets stored

| Column | Content |
| --- | --- |
| `tableName` / `rowKey` | which table and which primary key (an object; a composite key in full) |
| `action` | `insert` · `update` · `delete` |
| `actor` | whatever the resolver returned, or `null` |
| `changes` | `{ column: [before, after] }` — only what changed on an update; the whole row on insert/delete |
| `at` | when |

## Written in the same transaction

`enableAudit` wires the [repository signals](signals.en.md), so the entry is written on
the **same session** — and therefore in the same transaction — as the change:

```ts
await session.transaction(async () => {
  await orders.create(order);   // row + audit entry
  throw new Error("business rule");
});
// neither survives
```

!!! danger "Auditing a change that rolled back would be a lie"

    That is why the entry is not written "afterwards", in another transaction: a trail
    that records a change which never committed is worse than no trail.

!!! info "An update that changes nothing writes nothing"

    `update({ id }, { total: 10 })` on an order already worth 10 stores nothing — the
    diff comes out empty. A trail full of delta-less entries hides the ones that matter.

!!! warning "The `before` side costs a SELECT"

    To have the "before" of the diff, the `preSave` handler reads the current row. Every
    diffing trail pays that; if it hurts on a hot table, audit only the models that need
    it.

## Recap

- `auditLogModel(table)` gives the schema; `enableAudit(Model, ...)` turns it on and
  returns the switch that turns it off.
- The diff carries only what changed, with the actor resolved at write time.
- Same transaction as the change — a rollback takes the entry with it. 🚀
