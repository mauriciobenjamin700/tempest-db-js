# Custom column types

Money as integer cents, a `Temporal.Instant`, a branded id, a value object: the
conversion belongs to the **column**, not to every call site that forgets it.

```ts
import { column, customType } from "tempest-db-js";

const money = customType<Money, bigint>({
  base: () => column.bigInteger(),   // (1)!
  toDb: (value) => value.cents,
  fromDb: (cents) => Money.fromCents(cents),
});

class Order extends Model {
  static override tablename = "orders";
  id = column.integer().primaryKey();
  total = money().notNull();         // (2)!
}
```

1. A **factory**, not a ready column: each declaration needs its own instance.
2. It composes with `.notNull()`, `.default()`, `.unique()` like any column.

## Where the conversion happens

| Path | What runs |
| --- | --- |
| `create` / `createMany` / `update` | `toDb` before the value is bound |
| rows read (`select`, `RETURNING`, `stream`, joins) | `fromDb` after the base coercion |
| `where` (bare value, operator, `in` list, `between`) | `toDb` on the operand |
| DDL and the migration IR | **nothing** — the schema uses the `base` type |

```ts
await orders.list({ total: new Money(900n) });   // compared in cents, in the database
```

!!! info "The schema knows nothing about the custom type — which is why it cannot drift"

    The DDL emits the `base` type (`BIGINT`), so introspection and `tempest-db check` see
    an ordinary column. A custom type is an application decision; if it showed up in the
    schema, every existing database would start reading as divergent.

!!! warning "`null` passes straight through"

    `toDb`/`fromDb` are **not** called for `null`/`undefined` — a nullable column stays
    nullable, and the codec need not handle the case.

!!! danger "A SQL expression is not a domain value"

    `set({ total: sql.raw("total + 1") })` does **not** go through `toDb`: it is SQL to
    render, not a value to convert. If the expression has to match the stored
    representation, write it in that representation.

## Recap

- `customType({ base, toDb, fromDb })` returns a column factory.
- It converts on writes, on reads, and on `where` operands.
- The schema stays the base type's. 🚀
