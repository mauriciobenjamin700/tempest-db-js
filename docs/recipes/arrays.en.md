# PostgreSQL array columns

Model `text[]` / `integer[]` — native and common in Postgres — with an inferred
type and real operators.

## The problem

```sql
CREATE TABLE api_keys (
    id      SERIAL PRIMARY KEY,
    scopes  text[] NOT NULL DEFAULT ARRAY['send']::text[]
);
```

Without an array type, the only option is declaring the column as `jsonb` and
hoping. That *works* today — the value goes raw to the driver and postgres.js
serializes `string[]` on its own — and that is exactly the problem: the correct
behavior depends on the library **not** coercing the value. And
`checkDriftPostgres` reports drift forever, since the model says `jsonb` and the
database says `text[]`.

## `column.array()`

```ts
import { Model, column } from "tempest-db-js";

class ApiKey extends Model {
  static tablename = "api_keys";

  id = column.integer().primaryKey();
  scopes = column.array(column.text()).notNull().default(["send"]);  // (1)!
  quotas = column.array(column.integer());                            // (2)!
}
```

1. DDL: `"scopes" TEXT[] NOT NULL DEFAULT ARRAY['send']::TEXT[]`.
   Inferred type: `string[]`.
2. DDL: `"quotas" INTEGER[]`. Inferred type: `number[] | null`.

The element is any column, so the static type comes along:

```ts
type ApiKeyRow = InferModel<typeof ApiKey>;
// { id: number; scopes: string[]; quotas: number[] | null }
```

## Operators

An array you can only read whole is not worth much. Postgres's native operators
are available in `where`, typed for array columns only:

| Operator | SQL | Meaning |
| --- | --- | --- |
| `contains` | `@>` | the column contains every given element |
| `containedBy` | `<@` | every element of the column is in the given value |
| `overlaps` | `&&` | column and value share at least one element |

```ts
// Keys allowed to send
select(ApiKey).where({ scopes: { contains: ["send"] } });
// SELECT * FROM "api_keys" WHERE "scopes" @> $1

// Keys with any read scope
select(ApiKey).where({ scopes: { overlaps: ["read", "read:all"] } });
// SELECT * FROM "api_keys" WHERE "scopes" && $1
```

```ts
// @ts-expect-error - `contains` does not exist on a scalar column
select(ApiKey).where({ id: { contains: [1] } });
```

## Portability: an explicit error, not a fallback

SQLite and MySQL have no native array. The dialect **throws** when rendering the
DDL or the operator, instead of silently falling back to JSON:

```
column.array() is PostgreSQL-only — sqlite has no native array type.
Model the column as JSON there, accepting that array operators will not work.
```

!!! info "Why an error and not a fallback"

    A silent fallback would give the **same model** different semantics per
    dialect: `@>` would work on one database and not the other, and the SQLite
    test would pass while production on Postgres breaks. Failing at DDL rendering
    is the cheap moment to find that out.

    If your service needs both, declare `column.json<string[]>()` and accept that
    filtering by element happens in the application.

## Drift and migrations

The IR carries the element type (`{ kind: "array", meta: { element } }`), and
Postgres introspection unpacks `data_type = ARRAY` + `udt_name = _text` back into
the same shape. The result: `checkDriftPostgres` stays clean, and a `text[]` in
the database is no longer read as `text`.

## Reading and writing

The Postgres driver hands back native arrays, and the coercion layer decodes each
element by its declared type:

```ts
const row = await session.execute(select(ApiKey).where({ id: 1 })).one();
row.scopes;  // ["send", "read"] — string[], not string
```

Writing is direct:

```ts
await session
  .execute(update(ApiKey).set({ scopes: ["send", "read"] }).where({ id: 1 }))
  .rowsAffected();
```

!!! tip "Expression defaults"

    `default(["send"])` becomes `ARRAY['send']::TEXT[]`. For a default the builder
    does not model, use `sql.raw("'{}'::text[]")`.

## Recap

- `column.array(column.text())` → `text[]`, inferred as `string[]`.
- `contains` (`@>`), `containedBy` (`<@`) and `overlaps` (`&&`) in `where`, typed
  for array columns only.
- SQLite and MySQL throw an explicit error — no silent JSON fallback.
- Migrations and drift understand the element type.
