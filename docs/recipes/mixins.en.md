# Model mixins

The same columns show up on nearly every table: when the row was created, when it was
last touched, whether it was deleted, who changed it. Writing them per model is
repetition that **drifts** — one table gets `updatedAt` without `onUpdate`, another
spells it `updatedOn`.

A mixin is a function that takes the base class and returns a subclass carrying the
extra columns. It mirrors `tempest-fastapi-sdk`'s `SoftDeleteMixin` / `AuditMixin`.

## Timestamps

```ts
import { Model, column, withTimestamps } from "tempest-db-js";

class Article extends withTimestamps(Model) {
  static override tablename = "articles";
  id = column.integer().primaryKey();
  title = column.text().notNull();
}
```

You get two columns:

| Column | Type | Behavior |
| --- | --- | --- |
| `createdAt` | `Date` | `NOT NULL DEFAULT` from the database clock (`sql.now()`) |
| `updatedAt` | `Date` | same, plus `onUpdate(sql.now())` — every `UPDATE` rewrites it |

```ts
const row = await articles.create({ title: "hello" });  // no timestamps passed
row.createdAt;  // Date
await articles.update({ id: row.id }, { title: "hi" });
// UPDATE articles SET "title" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE ...
```

!!! info "`onUpdate` is applied on the write path, not in the schema"

    Only MySQL has a column-level `ON UPDATE`. Rendering it into the DDL would make the
    same model behave differently per database, so the value is injected into the
    `UPDATE` the builder assembles — and an explicit value in your `set()` **always
    wins**.

## Soft delete

```ts
import { Model, column, notDeleted, onlyDeleted, select, withSoftDelete } from "tempest-db-js";

class Article extends withSoftDelete(withTimestamps(Model)) {
  static override tablename = "articles";
  id = column.integer().primaryKey();
  title = column.text().notNull();
}

session.execute(select(Article).where(notDeleted()));   // deletedAt IS NULL
session.execute(select(Article).where(onlyDeleted()));  // deletedAt IS NOT NULL
```

!!! warning "Filtering is the caller's job"

    The mixin declares the column and nothing else. There is no hidden global filter — a
    query that forgets `notDeleted()` **sees** the deleted rows. That is deliberate: an
    invisible filter is the kind of magic that makes one `count()` disagree with
    another. Compose `notDeleted()` where it matters, or add a partial index
    `WHERE deletedAt IS NULL`.

## Actor audit

```ts
import { Model, column, withAudit } from "tempest-db-js";

class Article extends withAudit(Model) {          // createdBy/updatedBy as uuid
  static override tablename = "articles";
  id = column.integer().primaryKey();
}

class Order extends withAudit(Model, () => column.integer()) {  // integer user ids
  static override tablename = "orders";
  id = column.integer().primaryKey();
}
```

Both columns are **nullable** on purpose: a row created by a background job has no
actor, and a sentinel value there lies worse than a `NULL`. It takes a **factory**
(`() => column.integer()`), not a ready column, because the two properties need
independent instances.

## Composing

```ts
class Article extends withAudit(withSoftDelete(withTimestamps(Model))) {
  static override tablename = "articles";
  id = column.integer().primaryKey();
  title = column.text().notNull();
}
```

Mixin columns come **before** yours in the model's order — the same convention as the
SDK's `reorder_base_columns_first`. They are real columns: they show up in
`InferModel`, in `InferInsert`, in the migration IR and in the generated DDL.

## Recap

- `withTimestamps` → `createdAt` + `updatedAt` (with `onUpdate`).
- `withSoftDelete` → `deletedAt`; filter with `notDeleted()` / `onlyDeleted()`.
- `withAudit` → `createdBy` + `updatedBy`, with a configurable actor type.
- They compose with each other and with the rest of the model, with no special casing
  anywhere else in the package. 🚀
