# CTEs (`WITH` and `WITH RECURSIVE`)

A CTE **names** a query so the rest of the statement can select from it — and, in the
recursive form, so it can select from **itself**. That second form is the only way to walk
a tree (categories, a reply chain, a dependency graph) in one query instead of one per
level.

## Naming a query

```ts
import { cte, select } from "tempest-db-js";

const recent = cte("recent", Order, select(Order).where({ createdAt: { gte: yesterday } }));

const rows = await session.execute(recent.select().where({ status: "open" })).all();
// WITH "recent" AS (SELECT * FROM "orders" WHERE ...) SELECT * FROM "recent" WHERE ...
```

`cte(...).model` is a **real model** whose table is the CTE's name, so it works with
everything that already takes a model — `select`, `join`, `where` — with no special casing
anywhere.

## Walking a tree

```ts
import { cteRecursive, join, select, unionAll } from "tempest-db-js";

const subtree = cteRecursive("subtree", Category, (self) =>
  unionAll(
    select(Category).where({ id: rootId }),                                 // (1)!
    join(Category, "c").innerJoin(self, "s", { "c.parentId": "s.id" }).pick("c"),  // (2)!
  ),
);

const rows = await session.execute(subtree.select().orderBy("id")).all();
```

1. **Seed**: where the recursion starts.
2. **Step**: joins the table against the CTE itself. `.pick("c")` projects **only** the
   category, with bare column names — a `UNION` branch's columns must line up with the
   CTE's, and a join's composite row (`"c.id"`, `"s.id"`) does not.

!!! danger "Bounding the recursion is your job"

    Nothing stops a cycle (`a` parents `b` parents `a`) from running forever. If the graph
    can have one, carry the depth in the CTE and cut: `where({ depth: { lt: 10 } })` in the
    step. The database will not guess.

!!! info "The recursive reference goes in `FROM`, not in a subquery"

    `WHERE parentId IN (SELECT id FROM subtree)` is **not** a valid recursive CTE —
    PostgreSQL rejects it with "recursive reference must not appear within a subquery".
    That is why the step is a join.

!!! tip "`unionAll` when the tree has no cycles"

    `UNION` deduplicates, and deduplication costs. In a real tree each row appears once,
    so `unionAll` gives the same result more cheaply.

## Materialization (PostgreSQL 12+)

```ts
cte("heavy", Order, body, { materialized: true });
```

From PostgreSQL 12 on, a CTE used **once** is inlined — almost always what you want.
`materialized: true` pins the old behavior when the body is expensive and used twice;
`false` forces inlining. Where the dialect has no such syntax the option is ignored.

## Recap

- `cte(name, Model, body)` names it; `.select()` brings the `WITH` along.
- `cteRecursive(name, Model, (self) => …)` walks a tree in one query.
- `.pick(alias)` makes a join fit where a single-table `SELECT` fits.
- Bounding the depth is up to you. 🚀
