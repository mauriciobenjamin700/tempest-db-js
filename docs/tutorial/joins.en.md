# Joins

To combine tables, Querium has `join(...)` — and the result is a **composite
type**: an object with one key per table, each one holding its typed row.

## Step 1 — The basic join

Start from the base table with an **alias**, then join others:

```ts
import { join } from "querium";

const q = join(User, "user")
  .innerJoin(Order, "order", { "user.id": "order.userId" })
  .where({ "order.status": "paid" });
```

The result of `q` is inferred as:

```ts
{ user: UserRow; order: OrderRow }[]
```

One key per alias, each one holding the full row of that table. No flattening of
columns, no name collisions (`user.id` and `order.id` coexist).

## Step 2 — Typed `alias.column` refs

`on`, `where`, and `orderBy` use refs in the `"alias.column"` format — and they are
**checked at compile time**:

```ts
join(User, "user")
  .innerJoin(Order, "order", { "user.id": "order.userId" })  // ✅ valid columns
  .where({ "order.status": "paid" })                          // ✅
  .orderBy("order.amount", "desc");                           // ✅

// ❌ error: `user.bogus` is not a column of User
join(User, "user").innerJoin(Order, "order", { "user.bogus": "order.userId" });
```

## Step 3 — `leftJoin` and nullability

A `leftJoin` keeps the left-hand rows even without a match — so the right side can
be null. **The type reflects that**: the joined key becomes `Row | null`:

```ts
const q = join(User, "user").leftJoin(Order, "order", { "user.id": "order.userId" });
// result: { user: UserRow; order: OrderRow | null }[]
```

At execution, a row without a match brings `order: null` — and the type forces you
to handle it:

```ts
const rows = await session.execute(q).all();
for (const row of rows) {
  if (row.order) {
    console.log(row.user.name, row.order.amount); // `order` narrowed to OrderRow
  } else {
    console.log(row.user.name, "no orders");
  }
}
```

## Step 4 — Multiple joins

Chain as many as you need; each one adds a key to the composite type:

```ts
const q = join(User, "user")
  .innerJoin(Order, "order", { "user.id": "order.userId" })
  .leftJoin(Product, "product", { "order.productId": "product.id" });
// result: { user: UserRow; order: OrderRow; product: ProductRow | null }[]
```

## How it works under the hood

The dialect compiles the columns with an **alias** (`"user"."id" AS "user.id"`), so
the driver's flat row is **split** back into `{ user: {...}, order: {...} }`,
coercing each side by its model. For `leftJoin`, when all of the right side's
columns come back null, that side becomes `null`.

!!! note "Evolving"

    The typed-per-column operators (Phase 3) don't yet apply to the join `where` —
    today the `alias.column` keys are typed, but the value accepts a match or an
    operator without type restriction. Declarative relations (`hasMany`/`belongsTo`)
    and the `and`/`or` combinators are also on the roadmap.

## Recap

- `join(Model, alias)` starts it; `.innerJoin`/`.leftJoin(Model, alias, on)` add to it.
- The result is composite: `{ [alias]: Row }`, one key per table.
- `leftJoin` makes the side nullable (`Row | null`) — the type forces you to handle it.
- `on`/`where`/`orderBy` use typed `alias.column` refs.

You've covered Querium's main path! See the **[Reference](../reference.md)** for the
full API and the **[Roadmap](../roadmap.md)** for what's coming (migrations, relations).
