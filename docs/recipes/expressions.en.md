# Expressions in `where` (functions and column vs column)

Compare a column against **another column**, and apply SQL functions on both
sides — so a functional index is actually used instead of a sequential scan.

## The problem

The object form of `where` always compares `column <operator> value`:

```ts
select(Order).where({ total: { gt: 100 } });   // column vs value ✅
```

Two things are left out:

1. **Column vs column** — `WHERE total > paid` is not expressible.
2. **A function on the column side** — a functional index like
   `CREATE INDEX ON users (lower(trim(email)))` is unreachable, so the query that
   should use it becomes a scan.

## `col` — a column reference

```ts
import { col, select } from "tempest-db-js";

select(Order).where(col<OrderRow>("total").gt(col<OrderRow>("paid")));
// SELECT * FROM "orders" WHERE "total" > "paid"
```

Pass the row type (`col<OrderRow>(...)`) to get the name checked at compile time,
the same way `or<UserRow>(...)` already works.

!!! check "It respects the name mapping"

    `col()` takes the **property** name and goes through the same
    [column-name map](naming.md) as the rest of the builder. It is not a back door
    for writing the physical column name.

An operand that is **not** an expression is still bound as a parameter, so the
common case stays safe by default:

```ts
select(Order).where(col<OrderRow>("total").gte(100));
// WHERE "total" >= $1        params: [100]
```

## `fn` — SQL functions

```ts
import { fn, val, select } from "tempest-db-js";

select(AdminUser).where(fn.lower("username").eq(fn.lower(val(probe))));
// WHERE lower("username") = lower($1)
```

!!! warning "A string in `fn.*` is a **column**; a value needs `val()`"

    A function argument had to mean one thing, and a column is the dominant use
    (`fn.lower("username")`). To compare against a literal, wrap it in `val(...)`
    — which also makes it explicit where the parameter is bound.

    In the **operators** (`.eq()`, `.gt()`, …) the default is the opposite and
    equally safe: anything that is not an expression becomes a parameter.

Functions nest:

```ts
select(User).where(fn.lower(fn.trim("email")).eq(val(input.trim().toLowerCase())));
// WHERE lower(trim("email")) = $1
```

Portable across all three dialects: `lower`, `upper`, `trim`, `length`, `abs`,
`coalesce`.

### Any other function: `fn.call`

```ts
select(Order).where(fn.call("date_trunc", val("day"), "createdAt").eq(val(day)));
// WHERE date_trunc($1, "created_at") = $2
```

!!! danger "The function name is interpolated"

    `fn.call` writes the name straight into the statement, so it is validated as a
    plain SQL identifier and must **never** come from user input. The arguments,
    on the other hand, always go through the expression compiler.

    `date_trunc` is PostgreSQL, `strftime` is SQLite — `fn.call` does not pretend
    to be portable.

## Available operators

`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `ieq`, `in`, `notIn`,
`between`, `isNull` — the same names as the object form.

```ts
col<OrderRow>("total").between(10, 99);
fn.lower("email").ilike(val("%@acme.com"));
col<UserRow>("email").ieq(col<UserRow>("login"));   // lower(a) = lower(b)
```

!!! note "`in` and `between` bind their operands"

    Those operators bind the list, so an `Expression` there would be serialized as
    a parameter instead of becoming SQL. Passing one raises immediately:

    ```
    The "in" operator binds its operands, so it takes values, not expressions.
    ```

## It composes with everything else

```ts
import { and } from "tempest-db-js";

select(Order).where(
  and(col<OrderRow>("total").gt(col<OrderRow>("paid")), { status: "open" }),
);
// WHERE ("total" > "paid") AND ("status" = $1)
```

And in joins, the reference is `alias.property`:

```ts
join(Order, "o")
  .innerJoin(Customer, "c", { "o.customerId": "c.id" })
  .where(col("o.email").eq(col("c.email")));
// WHERE "o"."email" = "c"."email"
```

## `CASE` — conditional aggregation

`caseWhen` uses the **same** `where` language in its branches, so no second grammar
appears just for `CASE`:

```ts
import { caseWhen, col, select, sum, val } from "tempest-db-js";

const rows = await session
  .execute(
    select(Order).aggregate(["customer"], {
      paid: sum(caseWhen([[{ status: "paid" }, col("total")]], val(0))),
      all: sum("total"),
    }),
  )
  .all();
// SUM(CASE WHEN "status" = $1 THEN "total" ELSE $2 END) AS "paid"
```

One pass over the table instead of one query per bucket. Aggregates started accepting
expressions for exactly this — `sum`, `avg`, `min` and `max` take a column **or** an
expression.

Branches are evaluated in order; with no `ELSE`, a row matching none is `NULL`. A bare
value in a branch is **bound as a parameter**, not interpolated.

## `CAST` — converting in the database

```ts
select(Event).where(cast("externalId", "integer").gt(9));
// WHERE CAST("externalId" AS INTEGER) > $1
```

The target comes from a portable vocabulary, and each dialect renders the name it
accepts:

| Target | PostgreSQL | SQLite | MySQL |
| --- | --- | --- | --- |
| `integer` | `INTEGER` | `INTEGER` | `SIGNED` |
| `text` | `TEXT` | `TEXT` | `CHAR` |
| `numeric` | `NUMERIC` | `NUMERIC` | `DECIMAL` |
| `timestamp` | `TIMESTAMP` | `TEXT` | `DATETIME` |

!!! warning "A `CAST` on a column hides that column's index"

    `CAST(col AS ...)` in a `where` stops the plain index on `col` from being used —
    the database has to convert row by row. If the comparison is frequent, the fix is a
    **functional index** over the same expression, or fixing the column's type.

## `EXISTS` — "is there any?"

```ts
import { col, exists, notExists, select } from "tempest-db-js";

select(User).where(
  exists(select(Order).where({ userId: col("users.id"), status: "open" })),
);
// WHERE EXISTS (SELECT * FROM "orders" WHERE "userId" = "users"."id" AND "status" = $1)
```

`notExists` is the complement — customers **without** an open order.

!!! tip "`EXISTS` for existence, `IN` for membership"

    A correlated `EXISTS` can stop at the **first** matching row; an `IN` over a
    subquery materializes the set before comparing. When the question is "is there at
    least one?", `EXISTS` is the shape the planner optimizes best.

### Column against column, in the object form

`where({ userId: col("users.id") })` compares **two columns**. Such a value used to be
bound as a parameter in the object form — the subquery compared the column against the
string `"users.id"`. The `where` now accepts an expression both as a bare value and
inside an operator (`{ total: { gt: col("orders.paid") } }`).

## Scalar subqueries

```ts
const biggest = select(Order, ["total"])
  .where({ userId: col("users.id") })
  .orderBy("total", "desc")
  .limit(1)
  .asSubquery("total");

select(User).where(scalar(biggest).gt(100));
```

`scalar()` takes the result of `.asSubquery(column)`, not a bare builder — that is what
pins the projection to **one** column. A scalar subquery returning two columns is a
runtime error in every database; here it is a compile error.

## Table aliases outside a join

`join(Model, "a")` has always required an alias, so a self-join works there. A plain
`select()` had no way to name its own table — which is what a correlated subquery over the
**same** table needs: without an alias, the inner and outer `users` are the same name.

```ts
import { aliased, col, exists, select } from "tempest-db-js";

const sub = aliased(Employee, "sub");

select(Employee).where(
  exists(select(sub).where({ managerId: col("employees.id") })),
);
// WHERE EXISTS (SELECT * FROM "employees" AS "sub" WHERE "managerId" = "employees"."id")
```

`aliased(Model, "x")` returns a **real model**: same columns, same naming strategy, same
codecs. It works in `select`, in `join`, in `col("x.column")` and in row coercion, with no
special casing.

!!! info "An alias is not a second declaration of the table"

    Table args (`unique`, `check`, `index`) are **not** carried over. An alias is a way to
    **read** the table; reflecting it into a migration would try to create a table named
    after the alias.

!!! tip "For a CTE use `cte()` — there the name is the relation"

    In a CTE the name **is** the relation (`FROM "subtree"`), not a nickname for another
    table (`FROM "categories" AS "subtree"`). Different things, hence different functions.

## Recap

- `col<Row>("column")` references a column; comparing two gives `WHERE a > b`.
- `fn.lower/upper/trim/length/abs/coalesce` are portable; `fn.call` covers the
  rest without promising portability.
- In `fn.*`, a string is a **column** and a value goes in `val()`. In the
  operators, the default is a value.
- `in`/`between` refuse an expression rather than serializing it.
- Everything goes through the column-name map and join qualification.
