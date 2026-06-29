# Queries

With the `User` model from the previous page, let's build `SELECT` queries. In
tempest-db-js, `select(...)` returns a **chainable builder** that carries the result
type — before you ever touch a database.

!!! info "The builder doesn't execute (yet)"

    At this stage, `select(...)` builds a **typed AST**. The one that executes is
    Phase 4's `session.execute`. Today's value is **type safety**: the compiler
    already knows the exact shape of what the query will return.

## Step 1 — Select everything

```ts
import { select } from "tempest-db-js";

const q = select(User);
```

The result type of `q` is `UserRow[]` — all the columns, inferred from the class.
No manual annotation.

## Step 2 — Filter with `where`

```ts
const adults = select(User).where({ age: { gt: 18 } });
```

The **keys** of `where` are checked against the columns of `User`. Getting the
name wrong is a compile error:

```ts
// ❌ error: `agee` is not a column of User
select(User).where({ agee: { gt: 18 } });
```

### Typed operators per column

The **value** of each filter accepts an exact match (`eq` shorthand) or an
operator object. And the set of operators is **restricted to the column type** —
using an invalid operator is a compile error:

| Column type | Operators |
| --- | --- |
| `string` (varchar/text/uuid/enum) | `eq`, `ne`, `in`, `notIn`, `like`, `ilike`, `isNull` |
| `number` / `bigint` / `Date` | `eq`, `ne`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `between`, `isNull` |
| `boolean` | `eq`, `ne`, `isNull` |
| json / blob | `eq`, `ne`, `in`, `notIn`, `isNull` |

```ts
select(User).where({
  age: { gt: 18, lte: 65 },     // ✅ ordered on number
  name: { like: "%Ben%" },      // ✅ like on string
  active: true,                 // ✅ eq shorthand
  tags: { isNull: false },      // ✅ on any column
});

// ❌ compile error: `like` does not exist on number
select(User).where({ age: { like: "%18%" } });

// ❌ compile error: `gt` does not exist on string
select(User).where({ name: { gt: "a" } });
```

!!! check "Why this matters"

    The wrong operator for the column type is a bug that usually only shows up at
    runtime (or never). Here it **doesn't compile** — the column type carries which
    comparisons make sense.

### `and` / `or` / `not` combinators

The object form is an **implicit AND**. For `OR`, `NOT`, or to nest logic, use the
`and`/`or`/`not` combinators — they work in `select`, `update`, `delete`, and
`join`:

```ts
import { and, or, not } from "tempest-db-js";

// (age < 18) OR (age > 65)
select(User).where(or({ age: { lt: 18 } }, { age: { gt: 65 } }));

// active AND NOT (age < 18)
select(User).where(and({ active: true }, not({ age: { lt: 18 } })));
```

!!! tip "Key-safety in combinators"

    The top-level object form (`where({...})`) already checks the keys against the
    columns. Inside the combinators, pass the row type for full checking —
    `or<UserRow>({...}, {...})` — otherwise the keys stay permissive.

## Step 3 — Order, limit, paginate

The methods chain and are immutable (each returns a new builder):

```ts
const page = select(User)
  .where({ age: { gte: 18 } })
  .orderBy("age", "desc")
  .limit(20)
  .offset(40);
```

`orderBy` also validates the column:

```ts
// ❌ error: `bogus` is not a column of User
select(User).orderBy("bogus");
```

## Step 4 — Projection with `Pick`

Want only some columns? Pass the list as the second argument to `select`. The
result type becomes an exact `Pick`:

```ts
const names = select(User, ["id", "name"]);
// inferred result: Pick<UserRow, "id" | "name">[]
//   → { id: number; name: string }[]
```

The projection **survives chaining** — `where`, `orderBy`, `limit` don't undo it:

```ts
const q = select(User, ["id", "age"])
  .where({ age: { gt: 18 } })
  .orderBy("age", "desc");
// result: { id: number; age: number }[]
```

And projecting a nonexistent column is a compile error:

```ts
// ❌ error: `missing` is not a column of User
select(User, ["id", "missing"]);
```

## Inspecting the AST

The builder exposes its AST at `.node` — useful for debugging and for
understanding what will be compiled to SQL in Phase 4:

```ts
const q = select(User, ["id", "name"]).where({ age: { gt: 18 } }).limit(10);

console.log(q.node);
// {
//   kind: "select",
//   table: "users",
//   columns: ["id", "name"],
//   where: { age: { gt: 18 } },
//   orderBy: [],
//   limit: 10,
//   offset: undefined,
// }
```

## Recap

- `select(Model)` → a builder with a `Row[]` result.
- `select(Model, [cols])` → a projected `Pick<Row, cols>[]` result.
- `.where({...})` validates the **keys** against the columns (operators: Phase 3).
- `.orderBy(col, dir)`, `.limit(n)`, `.offset(n)` chain and are immutable.
- The AST lives at `.node`; execution is Phase 4.

Now let's **write** data. 👉 **[Insert, update, delete](mutations.md)**
