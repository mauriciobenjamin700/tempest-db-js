# Column names (`snake_case` in the database, `camelCase` in the code)

Keep the SQL convention in the database without letting it leak into the
TypeScript domain.

## The problem

`snake_case` is the universal convention in SQL. `camelCase` is the universal
convention in TypeScript. If the column name is always the property name, you are
forced to choose between two bad things:

1. **Properties in `snake_case`** — it works, but `InferModel` now renders
   `{ consumer_name: string, rate_limit_burst: number }`, and that type travels
   through service, controller and response schema. The database convention leaks
   all the way to the HTTP edge.
2. **Renaming the database columns** — it breaks the SQL convention, forces quotes
   in every hand-written query, and on a production database it is a rename
   migration on a hot table.

SQLAlchemy solves it with `mapped_column("consumer_name")`, Django with
`db_column`, Prisma with `@map`. Here there are two ways.

## Per column — `.name()`

```ts
import { Model, column } from "tempest-db-js";

class ApiKey extends Model {
  static tablename = "api_keys";

  id = column.integer().primaryKey();
  consumerName = column.text().name("consumer_name").notNull();  // (1)!
  rateLimitBurst = column.integer().name("rate_limit_burst").notNull();
}
```

1. The property stays `consumerName` in TypeScript; the column is `consumer_name`
   in the database.

## Per table — `static naming`

When the whole schema follows one convention, annotating column by column is
noise:

```ts
class ApiKey extends Model {
  static tablename = "api_keys";
  static naming = "snake_case";  // (1)!

  id = column.integer().primaryKey();
  consumerName = column.text().notNull();      // -> consumer_name
  rateLimitBurst = column.integer().notNull(); // -> rate_limit_burst
}
```

1. The values are `"preserve"` (the default — the property name, verbatim) and
   `"snake_case"`.

`.name()` still applies and **wins** over the table strategy, for the exception
every real schema has:

```ts
class ApiKey extends Model {
  static tablename = "api_keys";
  static naming = "snake_case";

  consumerName = column.text().notNull();               // -> consumer_name
  legacyId = column.text().name("legacyID").notNull();  // -> legacyID
}
```

## The mapping applies everywhere

It is not a `SELECT` detail. The translated name appears in every clause that
reaches SQL, and the property name in everything that comes back to TypeScript:

```ts
select(ApiKey, ["consumerName"])
  .where({ consumerName: { ieq: "acme" } })
  .orderBy("rateLimitBurst", "desc");
// SELECT "consumer_name" FROM "api_keys"
//  WHERE lower("consumer_name") = lower($1) ORDER BY "rate_limit_burst" DESC

const row = await session.execute(select(ApiKey).where({ consumerName: "acme" })).one();
row.consumerName;  // ✅ the property, not "consumer_name"
```

Full coverage: `select` (projection, `where`, `orderBy`, `groupBy`, aggregates),
`insert` (columns, `ON CONFLICT` target and predicate, `returning`), `update`
(`set` and `where`), `del`, joins (`"alias"."column"` qualification),
`BaseRepository`, active-record, and the **migration IR**.

!!! check "No false drift"

    The migration IR is produced in **column-name** space, the same space
    introspection reads from the database. That is why `checkDriftPostgres` stays
    clean — if the mapping only applied to queries, every renamed column would
    show up as "missing from the database".

!!! warning "A collision is an error, not last-write-wins"

    Two properties resolving to the same column raise on the model's first
    reflection:

    ```
    api_keys: properties "userName" and "user_name" both map to column "user_name".
    ```

## Cost

A model that renames nothing has a `null` map, and the compiler never even looks
it up — the hot path is identical to before. The map is memoized per class, like
the rest of model reflection.

## Recap

- `.name("column")` renames one column; `static naming = "snake_case"` renames the
  whole table.
- `.name()` overrides the table strategy.
- The mapping covers queries, mutations, joins, the repository and the migration
  IR — with no false drift.
- The row you get back is always in property-name space.
- A name collision fails loudly.
