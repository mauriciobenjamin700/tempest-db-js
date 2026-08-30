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

## Recap

- `col<Row>("column")` references a column; comparing two gives `WHERE a > b`.
- `fn.lower/upper/trim/length/abs/coalesce` are portable; `fn.call` covers the
  rest without promising portability.
- In `fn.*`, a string is a **column** and a value goes in `val()`. In the
  operators, the default is a value.
- `in`/`between` refuse an expression rather than serializing it.
- Everything goes through the column-name map and join qualification.
