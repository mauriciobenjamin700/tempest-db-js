# Set operations

`UNION`, `UNION ALL`, `INTERSECT` and `EXCEPT` combine two or more queries — something a
join does not do: the branches here are **independent** and may come from different
tables.

```ts
import { select, union } from "tempest-db-js";

const feed = union(
  select(Post, ["id", "createdAt"]).where({ authorId: me }),
  select(Comment, ["id", "createdAt"]).where({ authorId: me }),
)
  .orderBy("createdAt", "desc")
  .limit(50);

const rows = await session.execute(feed).all();
```

| Operator | What it does |
| --- | --- |
| `union` | everything from the branches, **deduplicated** |
| `unionAll` | everything from the branches, duplicates **kept** |
| `intersect` | only what appears in **every** branch |
| `except` | the first branch's rows that are **not** in the others |

!!! tip "`unionAll` when the branches cannot overlap"

    `UNION` has to sort or hash to remove duplicates. If the sets are disjoint by
    construction, `unionAll` returns the same rows without that cost.

## Shape checked by the type system

```ts
union(
  select(Post, ["id", "title"]),
  select(Comment, ["id", "body"]),   // ❌ compile error
);
```

Branches must project the **same** shape. That is the mistake the database only reports
at runtime and a typed builder catches first.

## `ORDER BY` and `LIMIT`: on the set, not on a branch

The result's `.orderBy()` / `.limit()` / `.offset()` apply to the **combined** query,
which is what SQL does. A branch carrying its own ordering or limit is
**parenthesized**:

```ts
union(
  select(Post, ["id"]).orderBy("createdAt", "desc").limit(3),   // (SELECT ... LIMIT 3)
  select(Comment, ["id"]),
);
```

Without the parentheses that `LIMIT` would bind to the whole set — a different query, and
a classic source of silently wrong output.

!!! warning "MySQL: `INTERSECT`/`EXCEPT` are out of scope"

    MySQL only gained both in 8.0.31, and this project does not invest in MySQL beyond
    what already works. Compiling `intersect`/`except` for MySQL **throws**, suggesting a
    join or `NOT EXISTS`. `union`/`unionAll` work normally.

## Recap

- Four operators, on the same executable builder as `select`.
- Branch shapes checked at compile time.
- Ordering and limits apply to the set; a branch with its own is parenthesized. 🚀
