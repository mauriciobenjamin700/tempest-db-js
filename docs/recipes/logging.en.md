# Query logging and errors with context

See the SQL that runs, and know exactly which query failed.

## Logging every query

Pass `onQuery` in the engine options — it's called per statement, with the SQL
and the bound params:

```ts
import { createEngine } from "tempest-db-js";

const engine = createEngine("sqlite:///app.db", {
  onQuery: ({ sql, params }) => {
    console.debug(sql, params);
  },
});
```

The hook fires for **every** session statement: `execute`, `stream`, and the
`BEGIN`/`COMMIT`/`SAVEPOINT` of transactions.

!!! warning "The logger never breaks a query"

    If your `onQuery` throws, the error is **swallowed** — logging never brings
    execution down. Don't rely on it for business logic.

!!! tip "Tracing / metrics"

    `onQuery` is the place to measure latency (stamp time, correlate by SQL),
    count queries per request, or feed a tracer.

## Errors carry the failing SQL

When the driver rejects a statement, tempest-db-js throws `QueryExecutionError` —
with the SQL and params attached, instead of an opaque driver message:

```ts
import { QueryExecutionError, insert } from "tempest-db-js";

try {
  session.execute(insert(User).values({ id: 1, name: "dup" }));
  session.execute(insert(User).values({ id: 1, name: "dup" })); // duplicate PK
} catch (err) {
  if (err instanceof QueryExecutionError) {
    console.error(err.message); // includes "SQL: INSERT INTO ... params: [...]"
    err.sql;    // the exact SQL that failed
    err.params; // the bound params, in order
    err.cause;  // the original driver error
  }
}
```

The `message` carries a safe preview (long values truncated, blobs as
`<N bytes>`); the `sql`/`params` props hold the full content for you to log.

## Recap

- `createEngine(url, { onQuery })` → per-statement `{ sql, params }` hook.
- A throwing logger is swallowed — never breaks the query.
- Driver failure → `QueryExecutionError` with `sql`, `params`, `cause`.
