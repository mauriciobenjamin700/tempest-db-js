# Aggregations, GROUP BY and DISTINCT

Count, sum and group — typed, without writing SQL.

## The problem

You want "how many orders per status" or "total revenue per region". That's
`GROUP BY` + aggregate functions. tempest-db-js exposes it with strong types: the
result is a row with the **group columns** (typed from the model) plus one field
per **aggregate alias**.

## Counting rows

```ts
import { Model, column, select, count, createSyncEngine } from "tempest-db-js";

class Order extends Model {
  static tablename = "orders";
  id = column.integer().primaryKey();
  status = column.text().notNull();
  amount = column.integer().notNull();
}

const session = createSyncEngine("sqlite:///shop.db").session();

// Whole-table aggregate: pass [] as groupBy.
const total = session.execute(select(Order).aggregate([], { n: count() })).scalar();
// total: number
```

!!! tip "`.scalar()` for a single number"

    A whole-table aggregate returns **one** row. `.scalar()` grabs its first
    value — perfect for a standalone `COUNT`.

## Grouping

```ts
import { count, sum } from "tempest-db-js";

const rows = session
  .execute(
    select(Order)
      .aggregate(["status"], { n: count(), total: sum("amount") })
      .orderBy("status"),
  )
  .all();
// rows: { status: string; n: number; total: number | null }[]
```

The row has `status` (a group column, typed from the model) + `n` and `total`
(the aliases). `count()` is always `number`; `sum`/`avg`/`min`/`max` are
`number | null` (null when the group has no values).

## Filtering before grouping

`where` comes **before** `GROUP BY` — it filters the rows that enter the groups:

```ts
select(Order)
  .where({ amount: { gt: 0 } })
  .aggregate(["status"], { total: sum("amount") });
// SELECT "status", SUM("amount") AS "total" FROM "orders" WHERE "amount" > ? GROUP BY "status"
```

## The aggregators

| Helper | SQL | Result type |
|---|---|---|
| `count()` | `COUNT(*)` | `number` |
| `sum("col")` | `SUM(col)` | `number \| null` |
| `avg("col")` | `AVG(col)` | `number \| null` |
| `min("col")` | `MIN(col)` | `number \| null` |
| `max("col")` | `MAX(col)` | `number \| null` |

!!! note "min/max are for numeric columns"

    `min`/`max` return `number | null`. For non-numeric columns (text, dates)
    the value comes back raw from the driver — handle the type yourself.

## HAVING — filtering by the aggregate result

`where` filters **rows**, before grouping. To filter **groups**, by what the
aggregation produced, use `.having()`:

```ts
const heavy = session
  .execute(
    select(Order)
      .where({ status: "open" })          // (1)!
      .aggregate(["customer"], { n: count(), total: sum("amount") })
      .having({ n: { gt: 10 } }),         // (2)!
  )
  .all();
// SELECT "customer", COUNT(*) AS "n", SUM("amount") AS "total" FROM "orders"
//  WHERE "status" = $1 GROUP BY "customer" HAVING COUNT(*) > $2
```

1. Filters the rows that enter the grouping.
2. Filters the groups that come out of it. The keys are the aliases you named,
   plus the `groupBy` columns.

!!! check "`.having()` without `.aggregate()` is a compile error"

    The builder only gains the method after grouping, so the wrong order fails the
    type-check instead of becoming invalid SQL at runtime.

!!! info "Why the SQL carries the expression, not the alias"

    PostgreSQL does **not** accept a `SELECT` alias in `HAVING` — `HAVING n > 10`
    fails. The compiler re-emits the expression (`COUNT(*) > $2`), which works on
    all three dialects. You still write the alias.

### Ordering by the alias

`ORDER BY`, unlike `HAVING`, accepts the alias on every dialect — and the builder
emits it as written:

```ts
select(Order).aggregate(["customer"], { n: count() }).orderBy("n", "desc");
// ... GROUP BY "customer" ORDER BY "n" DESC
```

## DISTINCT

To drop duplicate rows, `.distinct()`:

```ts
const statuses = session
  .execute(select(Order, ["status"]).distinct().orderBy("status"))
  .all();
// SELECT DISTINCT "status" FROM "orders" ORDER BY "status"
```

## Recap

- `.aggregate(groupBy, spec)` → row = group columns + aggregate aliases.
- `count` → `number`; `sum/avg/min/max` → `number | null`.
- `where` filters before `GROUP BY`; `.having()` filters after, by alias; `[]` as
  groupBy aggregates the whole table.
- `.orderBy(alias)` orders by the aggregate result.
- `.distinct()` emits `SELECT DISTINCT`.
