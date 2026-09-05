# Foreign keys, UNIQUE and table constraints

**Problem:** a real schema isn't just "columns with types". It has **integrity rules**: an
email can't repeat, a `post.author_id` must point at a `user` that exists, a `(user_id,
org_id)` pair may appear only once. Without them, the database happily stores garbage.

**Solution:** declare those rules **on the model**, exactly the way SQLAlchemy 2.0 does —
and tempest-db-js renders the right DDL (`UNIQUE`, `REFERENCES ... ON DELETE`,
`CONSTRAINT ...`) for SQLite, PostgreSQL and MySQL, plus detects them in *drift*.

## The theory in one sentence

- `.unique()` → a `UNIQUE` on that column (mirrors `mapped_column(unique=True)`).
- `.references("table.column", { onDelete })` → a foreign key (mirrors
  `mapped_column(ForeignKey("table.column", ondelete=...))`).
- `static tableArgs = () => [...]` → **table-level** constraints (composite / named),
  mirroring `__table_args__`.

!!! tip "None of this changes the inferred type"

    `.unique()` and `.references()` are **DDL metadata**. A `notNull` column stays
    non-null; a nullable column stays nullable. `InferModel`/`InferInsert` don't change.

## Step 1 — column-level UNIQUE

The most common case: a field that can't repeat.

```ts
import { Model, column } from "tempest-db-js";

class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
  email = column.varchar(120).notNull().unique(); // ← no duplicates
}
```

In the `CREATE TABLE` this becomes:

```sql
"email" VARCHAR(120) NOT NULL UNIQUE
```

## Step 2 — column-level foreign key

Point a column at another table's key. The reference is a `"table.column"` string — just
like SQLAlchemy's `ForeignKey("users.id")`.

```ts hl_lines="5"
class Post extends Model {
  static tablename = "posts";
  id = column.integer().primaryKey();
  title = column.text().notNull();
  authorId = column.integer().notNull().references("users.id", { onDelete: "cascade" });
}
```

Produces an inline FK:

```sql
"authorId" INTEGER NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE
```

The available actions (`onDelete` / `onUpdate`) are the standard SQL ones:

| Token             | Renders as      |
| ----------------- | --------------- |
| `"cascade"`       | `CASCADE`       |
| `"restrict"`      | `RESTRICT`      |
| `"set null"`      | `SET NULL`      |
| `"set default"`   | `SET DEFAULT`   |
| `"no action"`     | `NO ACTION`     |

!!! warning "SQLite doesn't enforce FKs by default"

    SQLite only honors foreign keys with `PRAGMA foreign_keys = ON`. The migration runner
    already turns it on during a table rebuild; for runtime enforcement, enable it on your
    driver when opening the connection.

## Step 3 — table-level constraints (composite / named)

When the rule spans **more than one column** — a composite UNIQUE or a composite FK — use
`static tableArgs`. It returns a list of helpers, resolved lazily (hence the thunk
`() => [...]`), which allows forward references.

```ts
import { Model, column, unique, foreignKey } from "tempest-db-js";

class Membership extends Model {
  static tablename = "memberships";
  userId = column.integer().notNull();
  orgId = column.integer().notNull();
  role = column.varchar(20).notNull();

  static tableArgs = () => [
    unique("userId", "orgId"),                                  // unique pair
    foreignKey(["userId"], "users", ["id"], { onDelete: "cascade" }),
  ];
}
```

Produces named table clauses:

```sql
CONSTRAINT "uq_memberships_userId_orgId" UNIQUE ("userId", "orgId"),
CONSTRAINT "fk_memberships_userId" FOREIGN KEY ("userId")
  REFERENCES "users" ("id") ON DELETE CASCADE
```

!!! info "Deterministic names"

    If you don't pass a `name`, tempest-db-js generates a stable one —
    `uq_<table>_<columns>` and `fk_<table>_<columns>`. A stable name matters: it's what the
    differ uses to tell whether a constraint was **added**, **removed** or **changed**
    between migrations.

## Migrations

Because everything becomes IR, the differ emits **reversible** operations when a
constraint changes:

```ts
import { diffSchema, reflectSchema } from "tempest-db-js/migrations";

const ops = diffSchema(reflectSchema([MembershipV1]), reflectSchema([MembershipV2]));
// → [{ kind: "add_constraint", ... }] or [{ kind: "drop_constraint", ... }]
```

- **PostgreSQL / MySQL:** become `ALTER TABLE ... ADD CONSTRAINT` / `DROP CONSTRAINT`
  (on MySQL, `DROP INDEX` / `DROP FOREIGN KEY`).
- **SQLite:** can't `ALTER` a constraint — the differ routes it through a table *rebuild*
  (`recreate_table`), the same path SQLite uses for any change that isn't an `ADD COLUMN`.

## Drift

`checkDrift` compares the model against the live database and sees FK/UNIQUE in a
**normalized** way — no matter whether you declared them per column or via `tableArgs`, it
compares by columns/target table:

```ts
import { checkDrift, NodeSqliteDriver } from "tempest-db-js";

const issues = checkDrift(driver, [User, Post, Membership]);
// [] = no drift; otherwise messages like:
// 'foreign key "posts: authorId=>users(id)" is missing from the database'
```

## `CHECK` and indexes

`tableArgs` knows four things: `unique`, `foreignKey`, **`check`** and **`index`**.

```ts
import { check, col, index, unique } from "tempest-db-js";

class Order extends Model {
  static override tablename = "orders";
  static override tableArgs = () => [
    check(col("total").gte(0)),                                   // (1)!
    index(["customerId", "createdAt"]),                           // (2)!
    index(["email"], { unique: true, where: { deletedAt: { isNull: true } } }),  // (3)!
  ];
  // ...
}
```

1. An invariant the **database** enforces — not the application, which is not the only
   thing writing to the table.
2. A plain index, created and dropped by migrations like everything else.
3. A **partial** index: the same predicate `ON CONFLICT` has to repeat in order to match
   it.

!!! info "A `CHECK`'s expression is a condition, not a string"

    `check(col("total").gte(0))` uses the **same** language as `where`. A raw string would
    have to be compared textually to decide whether the schema drifted — and two spellings
    of one rule would show up as a change on every diff.

!!! danger "An undeclared index is invisible — and disappears in a rebuild"

    An index created by hand outside the models is not in the IR, so migrations never
    create it; worse, on SQLite a column change **rebuilds the table**, and an index tied
    to the old table goes with it. Declaring it in `tableArgs` puts the index next to the
    columns it covers — and the rebuild recreates it.

!!! warning "Drift sees indexes, not `CHECK`s"

    `tempest-db check` compares explicit indexes (name, columns, uniqueness) on both
    databases. **`CHECK`s are left out**: the database returns the expression as SQL text,
    and comparing text against the condition tree would report a difference for every
    difference in spelling. `CHECK`s are still created and dropped by migrations — they
    are simply not compared.

    **Partial** indexes are left out of the comparison for the same reason (the predicate
    comes back as text).

| | PostgreSQL | SQLite | MySQL |
| --- | --- | --- | --- |
| `CHECK` | ✅ | ✅ (rebuild to alter) | ✅ |
| Index | ✅ | ✅ | ✅ |
| Partial index | ✅ | ✅ | **error** |

## Recap

- `.unique()` and `.references("table.column", { onDelete })` cover the per-column case.
- `static tableArgs = () => [unique(...), foreignKey(...)]` covers composite/named.
- None of them change the inferred type — they're DDL metadata.
- The same model drives `CREATE TABLE`, `ALTER`/rebuild in migrations and drift detection
  — one source of truth, across all three dialects.
