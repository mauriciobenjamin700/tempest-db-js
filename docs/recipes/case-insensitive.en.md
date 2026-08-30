# Case-insensitive comparison (and the `ilike` trap)

Username/e-mail login that ignores case — without opening an authentication
bypass on the way.

## The problem

A case-insensitive username is usually backed by a **functional** index:

```sql
CREATE UNIQUE INDEX admin_users_username_unique
    ON admin_users (lower(username));
```

And the matching lookup is `WHERE lower(username) = lower($1)`.

## ⚠️ The obvious workaround is a trap

Since `ilike` exists and is "case-insensitive", the temptation is to use it as if
it were an `eq`:

```ts
// ❌ DO NOT do this in an authentication lookup
select(AdminUser).where({ username: { ilike: probe } });
```

Tested against a real Postgres:

```
ilike "mixedcase"  -> 1 row
ilike "MIXEDCASE"  -> 1 row
ilike "%"          -> 1 row    <-- matches EVERY row
```

!!! danger "`ilike` is *pattern matching*, not equality"

    `%` and `_` are wildcards. In an authentication lookup, a username of `"%"`
    matches the first row of the table — whoever writes that workaround without
    remembering to escape has just opened a login bypass. And `ILIKE` **does not
    use** the `lower(username)` index: it becomes a sequential scan.

## ✅ The fix — `ieq`

```ts
import { select } from "tempest-db-js";

const user = await session
  .execute(select(AdminUser).where({ username: { ieq: probe } }))
  .oneOrNull();
```

It compiles to exactly what the functional index expects, on all three dialects:

```sql
-- PostgreSQL
SELECT * FROM "admin_users" WHERE lower("username") = lower($1)
-- SQLite
SELECT * FROM "admin_users" WHERE lower("username") = lower(?)
-- MySQL
SELECT * FROM `admin_users` WHERE lower(`username`) = lower(?)
```

No wildcards, no escaping, and it matches the `lower(username)` index.

```ts
select(AdminUser).where({ username: { ieq: "%" } });  // 0 rows — it is a literal
```

`ieq` is a string operator: the type-checker rejects it on a numeric, boolean or
date column, exactly like `like`/`ilike`.

## When `ilike` is still right

`ilike` remains the right tool for what it actually is: **pattern search**, with a
deliberate wildcard.

```ts
// Autocomplete search — the "%" is yours, and it is intentional
select(Product).where({ name: { ilike: `${escapeUserInput(term)}%` } });
```

!!! tip "Rule of thumb"

    If the compared value comes from the user and you mean **equality**, use
    `ieq`. If you are building the pattern yourself, use `ilike` — and handle
    `%`/`_` in the user-supplied part.

## Recap

- `{ ieq: value }` → `lower(col) = lower($1)`: case-insensitive equality,
  portable, no wildcards, and it uses a functional index.
- `{ ilike: pattern }` → pattern matching. `%` and `_` are wildcards; `"%"`
  matches everything.
- Never use `ilike` for authentication, or for any lookup that should be equality.
