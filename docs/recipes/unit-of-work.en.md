# Unit of work and identity map (opt-in)

The package's default stays what it was: **a row is a plain object**, and a write happens
when you ask. This is the other model, for code that prefers it: load, mutate, and let a
single `flush()` work out the statements.

```ts
const uow = session.unitOfWork();

const ana = await uow.get(User, 1);
const same = await uow.get(User, 1);    // (1)!

ana.visits += 1;
uow.add(Post, { id: 10, userId: 1, title: "new" });

await uow.flush();                       // (2)!
```

1. **The same instance** — and no second query.
2. One transaction: inserts, then updates, then deletes.

## What it buys

| | Without a unit of work | With |
| --- | --- | --- |
| Loading a row twice | two objects that can drift apart | **one** object |
| Ten mutations | ten round trips | the statements the changes require, in one commit |
| Updates | you pick the columns | only what actually changed |

## `Tracked<Row>` in the type

`get()` returns `Tracked<Row>` — the row's own shape, plus a brand. A function requiring
`Tracked<Row>` will not take a loose object that nothing will ever flush:

```ts
function scheduleLater(row: Tracked<UserRow>): void { /* ... */ }
scheduleLater(await uow.get(User, 1));   // ok
scheduleLater(await users.getById(1));   // ❌ compile error
```

!!! info "The diff is by value, not by reference"

    `Date` and `Uint8Array` are compared by **content**: reassigning the same instant is
    not a change. Comparing by reference would rewrite every row holding a `Date` on every
    flush.

!!! warning "The order is inserts → updates → deletes, not a topological sort"

    That order keeps a foreign key satisfied when a new parent and its children are
    flushed together. It is **not** a dependency sort: a graph that needs one should be
    flushed in stages.

!!! danger "A failure mid-flush takes the whole flush with it"

    Everything runs in one transaction. A failing statement rolls the set back, and the
    tracked state is left **untouched** — fix it and call `flush()` again.

!!! tip "Explicit scope"

    One `unitOfWork()` per request, per job, per use case. Nothing global, nothing shared
    between requests. `clear()` forgets everything without writing.

## Recap

- `session.unitOfWork()` → an identity map plus a change log.
- `get`/`track`/`add`/`remove`, and one `flush()` in a transaction.
- An update writes **only** what changed; nothing changed ⇒ no statement.
- The plain-object default path is untouched. 🚀
