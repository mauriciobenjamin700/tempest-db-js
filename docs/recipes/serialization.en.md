# Serialization (row ↔ JSON)

**Problem:** a database row has native types — `Date`, `bigint`, `Uint8Array` — that
**don't survive `JSON.stringify`** on their own (`bigint` throws, `Date` becomes an
uncontrolled string, `blob` turns into garbage). And when a JSON arrives from outside
(an HTTP request, a queue), you want to **validate and coerce** it back into the right
types before writing.

**Solution:** tempest-db-js ships a pair of functions that know the model's schema —
`toJSON`/`stringify` to go **out**, `fromDict`/`parse` to come **in** — à la Pydantic's
`model_dump`/`model_validate`.

## The theory in one sentence

Serialization is **model-driven**: each function looks at the class's columns and coerces
each field by its SQL type. Unknown columns are ignored; required ones that are missing
become a validation error.

## Output: row → JSON

```ts
import { Model, column, toJSON, stringify, toDict } from "tempest-db-js";

class Event extends Model {
  static tablename = "events";
  id = column.bigInteger().primaryKey();        // bigint
  name = column.text().notNull();
  at = column.datetime().notNull();             // Date
  payload = column.blob().notNull();            // Uint8Array
}

const row = {
  id: 9007199254740993n,
  name: "deploy",
  at: new Date("2026-06-29T12:00:00Z"),
  payload: new Uint8Array([1, 2, 3]),
};

toJSON(Event, row);
// {
//   id: "9007199254740993",            // bigint → string (without losing precision)
//   name: "deploy",
//   at: "2026-06-29T12:00:00.000Z",    // Date → ISO
//   payload: "AQID",                    // Uint8Array → base64
// }

stringify(Event, row); // == JSON.stringify(toJSON(Event, row))
```

!!! info "`toDict` vs `toJSON`"

    - `toDict(Model, row)` returns the **native values**, restricted to the known columns
      (no coercion) — handy for passing along inside TS.
    - `toJSON(Model, row)` returns a **JSON-safe** version (`Date`→ISO, `bigint`→string,
      `Uint8Array`→base64) — ready for `JSON.stringify` / an HTTP response.

## Input: JSON/dict → validated row

`fromDict` coerces each field back into its native type (string→`Date`/`bigint`/`Uint8Array`,
`JSON.parse` on json columns) and **validates required ones**:

```ts
import { fromDict, parse, ValidationError } from "tempest-db-js";

const row = fromDict(Event, {
  id: "9007199254740993",          // string → bigint
  name: "deploy",
  at: "2026-06-29T12:00:00.000Z",  // string → Date
  payload: "AQID",                  // base64 → Uint8Array
});
row.at instanceof Date; // true

// parse = fromDict(Model, JSON.parse(json))
const fromHttp = parse(Event, requestBodyString);
```

Missing a required column (`notNull` and no default)? `ValidationError`:

```ts
try {
  fromDict(Event, { id: "1" }); // name, at, payload are missing
} catch (err) {
  if (err instanceof ValidationError) {
    console.error(err.message); // describes the missing required columns
  }
}
```

!!! tip "Where this fits in an API"

    On an HTTP route: `parse(Model, await req.text())` to validate the body on the way
    **in**, and `toJSON(Model, row)` to build the response on the way **out**. The
    `BaseRepository` already returns native rows — serialize only at the boundary. See the
    [REST API example](../examples/rest-api.en.md).

## Recap

- `toJSON`/`stringify` → row → JSON-safe (`Date`→ISO, `bigint`→string, `blob`→base64).
- `toDict` → native values restricted to the columns (no coercion).
- `fromDict`/`parse` → JSON/dict → validated and coerced row; throws `ValidationError`.
- Everything **driven by the model's schema** — a single source of truth, just like Pydantic.
