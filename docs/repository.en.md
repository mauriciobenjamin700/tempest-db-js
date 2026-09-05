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

## Recap

- `new BaseRepository(Model, session)` — typed CRUD + pagination.
- `getById` throws `RecordNotFound`; `list` returns `[]` (404 convention).
- Composite keys: `getById({ ... })` with the whole key; a scalar throws.
- `paginate` returns items + metadata, with a typed `orderBy`.
- `PaginationFilter`/`PaginationResult` aligned with `tempest-fastapi-sdk`.
