# created_at / updated_at

**Problem:** almost every table wants to know *when* a row was created and *when* it was
last updated — but setting that by hand on every `insert`/`update` is easy to forget and
easy to get wrong.

**Solution:** let the **database** fill it in, with portable defaults (`sql.now()`) and
`onUpdate(...)`. tempest-db-js renders the right SQL per dialect (`CURRENT_TIMESTAMP`
on SQLite, `now()` on PostgreSQL).

## The theory in one sentence

- `.default(sql.now())` → the value is filled in **on INSERT** if you don't pass anything.
- `.onUpdate(sql.now())` → the value is **reapplied on every UPDATE**, automatically.

It's the same model as SQLAlchemy's `server_default` + `onupdate`.

## The model

```ts
import { Model, column, sql } from "tempest-db-js";

class Article extends Model {
  static tablename = "articles";
  id = column.integer().primaryKey();
  title = column.text().notNull();
  createdAt = column.datetime().notNull().default(sql.now());            // set on insert
  updatedAt = column.datetime().notNull().default(sql.now()).onUpdate(sql.now()); // and on every update
}
```

Because `createdAt` and `updatedAt` have a default, they are **optional on insert** — the
`InferInsert` type reflects that:

```ts
import { type InferInsert } from "tempest-db-js";

type ArticleInsert = InferInsert<typeof Article>;
// { title: string; id?: number; createdAt?: Date; updatedAt?: Date }
//   ^ you only need to pass `title`
```

## In use

```ts
import { insert, update, select } from "tempest-db-js";

// INSERT — we don't pass the timestamps; the database fills both in
session.execute(insert(Article).values({ title: "Hello, world" }));

const [article] = session.execute(select(Article)).all();
console.log(article.createdAt); // Date — filled in by the database
console.log(article.updatedAt); // Date — equal to createdAt at this point

// UPDATE — we don't touch updatedAt; onUpdate handles it
session.execute(update(Article).set({ title: "New title" }).where({ id: article.id }));

const [fresh] = session.execute(select(Article)).all();
console.log(fresh.updatedAt > fresh.createdAt); // true — updatedAt advanced on its own
```

!!! info "The default lives on the column"

    The value of `.default()`/`.onUpdate()` lives in `Article.createdAt.defaultValue` —
    it's exactly what feeds the migration IR. In other words: the same model drives both
    execution and the generation of `CREATE TABLE`. A single source of truth.

## Useful variations

=== "created_at only"

    ```ts
    createdAt = column.datetime().notNull().default(sql.now());
    ```

=== "UUID as PK"

    ```ts
    id = column.uuid().primaryKey().default(sql.uuidv4()); // generated in the database
    ```

=== "With timezone (PostgreSQL)"

    ```ts
    createdAt = column.datetime({ timezone: true }).notNull().default(sql.now());
    // → TIMESTAMP WITH TIME ZONE
    ```

## Recap

- `.default(sql.now())` fills in on INSERT; `.onUpdate(sql.now())` reapplies on UPDATE.
- Columns with a default become **optional** in `InferInsert` — you don't pass a timestamp.
- Portable expressions (`sql.now()`, `sql.uuidv4()`, …) become the right SQL per dialect.
- The same default feeds the migrations — schema and runtime never drift.
