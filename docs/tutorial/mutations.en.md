# Insert, update, delete

Reading is half the story. Now let's **write** — and see how tempest-db-js uses the type
system to prevent a classic mistake: wiping a whole table by accident.

## INSERT

`insert(Model).values(...)` is typed by `InferInsert` (remember the
[Models](models.md) page: PK and defaults are optional):

```ts
import { insert } from "tempest-db-js";

insert(User).values({ name: "Ben", age: 30, nickname: null });
```

Missing a required column? Compile error:

```ts
// ❌ error: `age` is required
insert(User).values({ name: "Ben", nickname: null });
```

### Insert multiple rows

`values` accepts a single row or an array:

```ts
insert(User).values([
  { name: "Ana", age: 22, nickname: null },
  { name: "Beto", age: 41, nickname: "B" },
]);
```

### `.returning()` — get back what was inserted

Without `returning`, the execution result is the **number of affected
rows**. With `returning`, it's the row (or a projection of it):

```ts
// full row
const full = insert(User)
  .values({ name: "x", age: 1, nickname: null })
  .returning();
// inferred result: UserRow

// only some columns
const onlyId = insert(User)
  .values({ name: "x", age: 1, nickname: null })
  .returning(["id"]);
// inferred result: { id: number }
```

## UPDATE — and the safety guard

`update(Model).set(...)` defines the columns to change (partial — only the ones you
pass get changed):

```ts
import { update } from "tempest-db-js";

update(User).set({ age: 31 }).where({ id: 1 });
```

`set` validates the columns:

```ts
// ❌ error: `bogus` is not a column
update(User).set({ bogus: 1 });
```

### The typed guard against full-table writes

Here's the important part. An `UPDATE` **without a `WHERE`** changes **all the rows**
— almost always an accident. tempest-db-js models this **in the type**: an update starts
in the `Guarded = false` state and only becomes **executable** after a `.where(...)`:

```ts
const safe = update(User).set({ age: 31 }).where({ id: 1 });
//    ^ Guarded = true  → session.execute accepts it

const unsafe = update(User).set({ age: 0 });
//    ^ Guarded = false → session.execute will REJECT it at compile time
```

Really need to update the whole table? Say so **explicitly** with `.unguarded()` —
it makes it obvious in code review that it was intentional:

```ts
const all = update(User).set({ age: 0 }).unguarded();
//    ^ Guarded = true  → allowed, but on purpose
```

!!! danger "Why this matters"

    `UPDATE users SET age = 0` without a `WHERE` zeroes out everyone's age. In other
    ORMs that compiles without complaint. In tempest-db-js, you either filter with
    `.where()` or declare `.unguarded()` out in the open — there's no silent path to
    disaster.

## DELETE — same guard

`del(Model)` (the name is `del` because `delete` is a reserved word in JS) follows
exactly the same rule:

```ts
import { del } from "tempest-db-js";

del(User).where({ id: 1 });        // ✅ guarded, safe
del(User).unguarded();             // ✅ deletes everything, but on purpose
del(User);                         // ⚠️ Guarded = false → execution rejected
```

`returning` also works on delete:

```ts
const removed = del(User).where({ id: 1 }).returning(["name"]);
// inferred result: { name: string }
```

## Recap

- `insert(Model).values(...)` — typed by `InferInsert`; accepts 1 or N rows.
- `.returning()` → full row; `.returning([cols])` → `Pick`.
- `update(Model).set(...)` validates the columns; it's partial.
- **Typed guard**: `update`/`del` only execute after an explicit `.where()` or
  `.unguarded()` — an accidental full-table write becomes a compile error.
- `del` is `delete` (a reserved word).

Now that you know how to build every query, let's **execute them** against a real
database. 👉 **[Running queries](execution.md)**
