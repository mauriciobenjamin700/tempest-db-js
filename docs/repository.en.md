# Repository

`BaseRepository<Model>` is a **fully typed** CRUD + pagination layer over a model
and an async session — mirroring the `BaseRepository` from `tempest-fastapi-sdk`.
It's the data foundation of the future `tempest-ts-sdk`.

```ts
import { BaseRepository, createEngine } from "tempest-db-js";

const engine = createEngine("sqlite:///app.db");
const users = new BaseRepository(User, engine.session());
```

## CRUD

```ts
const user = await users.create({ name: "Ana", age: 30, active: true }); // created row
await users.createMany([{ name: "Beto", age: 40, active: false }]);

const one = await users.getById(user.id);          // throws RecordNotFound if absent
const maybe = await users.getByIdOrNull(999);       // null if absent
const first = await users.first({ active: true });  // row | null
const all = await users.list({ age: { gte: 18 } }); // always [] when nothing matches

await users.update({ id: user.id }, { age: 31 });   // number of affected rows
await users.delete({ active: false });              // number of affected rows
```

!!! check "404 convention honored"

    `getById` throws `RecordNotFound` when it doesn't find a match (single-record
    lookup). But collection methods (`list`) return **`[]`** when nothing matches —
    "no results" is success, not an error. Just like GitHub/Stripe/AWS.

## Count and existence

```ts
await users.count();                  // total
await users.count({ active: true });  // filtered total
await users.exists({ age: { gt: 65 } });
```

## Typed pagination

```ts
const page = await users.paginate({
  page: 1,
  pageSize: 20,
  orderBy: "age",        // typed column of the model
  ascending: false,
  filters: { active: true },
});
// { items: UserRow[], total, page, pageSize, pages }
```

`PaginationFilter` and `PaginationResult` mirror `BasePaginationFilterSchema` and
`BasePaginationSchema<T>` from the Python SDK, so the payload shape is the same
between the Python and TS backends.

## Extending

Subclass to add domain methods — the model types propagate:

```ts
class UserRepository extends BaseRepository<typeof User> {
  constructor(session: AsyncSession) {
    super(User, session);
  }

  activeAdults() {
    return this.list({ active: true, age: { gte: 18 } }); // Promise<UserRow[]>
  }
}
```

## Relations (typed eager-loading)

Declare relations with `hasMany`/`belongsTo` and load them with `loadRelations` — **one
query per relation** (no N+1). The result type is widened: `hasMany` becomes `Row[]`,
`belongsTo` becomes `Row | null`.

```ts
import { hasMany, belongsTo, loadRelations, select } from "tempest-db-js";

const users = await session.execute(select(User)).all();
const withPosts = await loadRelations(session, users, {
  posts: hasMany(() => Post, { localKey: "id", foreignKey: "userId" }),
});
withPosts[0].posts; // PostRow[]

const posts = await session.execute(select(Post)).all();
const withAuthor = await loadRelations(session, posts, {
  author: belongsTo(() => User, { localKey: "userId", foreignKey: "id" }),
});
withAuthor[0].author; // UserRow | null
```

## Composite primary keys

A model with more than one `primaryKey()` column is identified by **all** of them.
`getById` takes an object carrying the whole key:

```ts
class OrderLine extends Model {
  static override tablename = "order_lines";
  orderId = column.integer().primaryKey();
  lineNumber = column.integer().primaryKey();
  sku = column.varchar(40).notNull();
}

const lines = new BaseRepository(OrderLine, session);
const line = await lines.getById({ orderId: 1, lineNumber: 2 });
```

The same holds for active-record: `activeRecord(OrderLine, session).get({ orderId, lineNumber })`,
and `update`/`delete`/`reload` filter on the whole key.

!!! danger "A scalar for a composite key is an error, not half a key"

    ```ts
    await lines.getById(1);
    // Error: order_lines has a composite primary key (orderId, lineNumber);
    //        pass an object like { orderId, lineNumber } instead of a scalar.
    ```

    A scalar cannot say **which** key column it is. Before this threw, the filter went
    out with half the key (`WHERE orderId = 1`) and returned — or updated — the wrong
    row whenever the order had more than one line.

    An incomplete key (`{ orderId: 1 }`) throws too, naming the missing column.

A single-column key still takes the bare value (`getById(7)`) **and** the object
(`getById({ id: 7 })`).

## The methods beyond CRUD

| Method | What for |
| --- | --- |
| `existsExcluding(filters, key)` | uniqueness **on an update**: "does another row already use this e-mail?" |
| `bulkUpsert(rows, { conflictColumns, update? })` | batch `ON CONFLICT`, one statement |
| `softDelete(key)` / `restore(key)` | the `withSoftDelete` mixin's other half |
| `deleteBatch(keys)` | `DELETE ... WHERE id IN (...)`, returning the count |
| `changesSince({ since, cursor, limit })` | delta sync for an offline client |

### `existsExcluding`

```ts
if (await users.existsExcluding({ email }, userId)) {
  throw new EmailTaken();
}
```

`exists({ email })` would find **the row being edited** and report a false conflict.

### `bulkUpsert`

```ts
await settings.bulkUpsert(rows, { conflictColumns: ["key"] });
```

Writing N rows, the new value cannot be a literal — each row has its own. So the `SET`
references the incoming row: `sql.excluded("col")`, which becomes `excluded."col"` on
PostgreSQL and SQLite and `VALUES(col)` on MySQL. `update:` restricts which columns get
overwritten.

### `softDelete` / `restore`

They require the `deletedAt` column (from `withSoftDelete`). Without it they **throw**,
naming the mixin — rather than emitting SQL against a column that does not exist.

### `changesSince` — delta sync

```ts
let cursor: string | null = null;
let since = clientWatermark;             // null on the first sync
do {
  const page = await items.changesSince({ since, cursor, limit: 200 });
  apply(page.items);
  cursor = page.nextCursor;
  if (cursor === null) clientWatermark = page.serverTime;   // (1)!
} while (cursor !== null);
```

1. Persist **`serverTime`**, not the newest `updatedAt` you saw.

!!! danger "The watermark is `serverTime`, not the newest `updatedAt`"

    `serverTime` is read **before** the query runs. A row committed while the page was
    being built carries a later timestamp, so it surfaces on the next pull. Using the
    newest `updatedAt` you received would let that row fall into the gap between the two
    syncs — and disappear for good.

!!! info "A deleted row comes back as a tombstone"

    With the soft-delete mixin, a deleted row **is returned**, with `deletedAt` set. That
    is how the client knows to drop its local copy; filtering deletions out would strand
    the row on the device forever.

!!! warning "`changesSince` wants an index"

    The query filters and orders by `updatedAt`. Without an index on that column every
    pull is a full scan.

## Multi-tenant: a scope you cannot forget

In a shared-schema database every row lives in the same table, and one forgotten
`WHERE tenantId = ?` leaks one customer's data to another. The problem is not the
predicate — it is that **every** query site has to remember it.

```ts
const docs = new TenantScopedRepository(Doc, session, {
  column: "tenantId",
  id: currentTenant,
});

await docs.list({ status: "open" });   // ... AND "tenantId" = ?
await docs.create({ title: "new" });   // tenantId filled in
```

The predicate joins **every** read — `list`, `first`, `exists`, `count`, `getById`,
`paginate`, `cursorPaginate`, `update`, `delete` — because those methods go through a
single scoping point (`scopeFilters`), not because each one remembers.

!!! danger "Another tenant's row is "not found", not "forbidden""

    `getById` of another customer's row raises `RecordNotFound` — the same as a row that
    does not exist. Telling the two apart would already be a leak: it would confirm that
    the id exists somewhere else.

!!! warning "Writing another tenant **throws**"

    ```ts
    await docs.create({ id: 5, tenantId: 2, title: "x" });
    // Error: Refusing to write docs.tenantId = 2 from a repository scoped to 1
    ```

    Silently overwriting it would turn a caller's bug into data that looks deliberate.

!!! info "The filter is added to, never replaced"

    Passing `{ tenantId: other }` in a filter yields a contradiction that matches nothing
    — not a window into the other tenant.

A model without the tenant column makes the constructor throw: a scope that silently
matches nothing is worse than no scope at all.

## Recap

- `new BaseRepository(Model, session)` — typed CRUD + pagination.
- `getById` throws `RecordNotFound`; `list` returns `[]` (404 convention).
- Composite keys: `getById({ ... })` with the whole key; a scalar throws.
- `paginate` returns items + metadata, with a typed `orderBy`.
- `PaginationFilter`/`PaginationResult` aligned with `tempest-fastapi-sdk`.
