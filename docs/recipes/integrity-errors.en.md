# Answering 409 with the right constraint

The database says **why** it refused a write — in the driver's prose, not your
application's. `parseIntegrityError` reads that prose back into a structure:

```ts
import { BaseRepository, parseIntegrityError } from "tempest-db-js";

try {
  await users.create({ email, tenantId });
} catch (error) {
  const failure = parseIntegrityError(error, User);   // (1)!
  if (failure?.violation === "unique" && failure.columns.includes("email")) {
    return json({ code: "EMAIL_TAKEN", field: "email" }, { status: 409 });
  }
  throw error;                                        // (2)!
}
```

1. The model is optional; passing it translates **database** names back to properties
   (`idempotency_key` → `idempotencyKey`) for anyone using `naming = "snake_case"`.
2. Not an integrity violation ⇒ `null`. Rethrowing is right: swallowing here would hide
   a syntax error, a deadlock, a dropped connection.

## What comes back

| Field | Carries |
| --- | --- |
| `violation` | `"unique"` · `"foreignKey"` · `"notNull"` · `"check"` · `"exclusion"` |
| `constraint` | the name, when the database reports one (PostgreSQL does, SQLite does not) |
| `table` | the table, when reported |
| `columns` | the covered columns — **all** of them on a composite constraint |
| `detail` | the driver's raw message, for logs |

## What each database gives you

The same failure arrives in two different shapes, and the difference is not cosmetic:

=== "PostgreSQL"

    ```
    code: "23505"
    constraint_name: "uq_users_email_tenant_id"
    detail: "Key (email, tenant_id)=(a@b, 7) already exists."
    ```

    The constraint's name plus the column list in a `DETAIL:` line — which is where the
    columns come from, rather than `column_name`, which only carries one.

=== "SQLite"

    ```
    message: "UNIQUE constraint failed: users.email"
    code: "SQLITE_CONSTRAINT_UNIQUE"   (better-sqlite3)
    errcode: 2067                       (node:sqlite)
    ```

    Table and columns inside the message, and the constraint's name nowhere. The two
    SQLite drivers report the **code** differently; both are recognized.

!!! warning "MySQL returns `null`"

    MySQL is outside the project's active scope, so an `ER_DUP_ENTRY` returns `null`
    rather than a guess. `null` means "I don't know", not "it wasn't a violation" —
    handle it by rethrowing, like any unknown error.

!!! tip "A composite constraint comes back whole"

    `columns` carries **every** column of a composite unique, which is exactly what
    decides whether the user-facing message talks about the email or about the
    (email, tenant) pair.

## Recap

- `parseIntegrityError(error, Model?)` → `IntegrityFailure | null`.
- It follows the `cause` chain, so this package's `QueryExecutionError` is no obstacle.
- Pass the model to get property names instead of column names.
- `null` ⇒ rethrow. 🚀
