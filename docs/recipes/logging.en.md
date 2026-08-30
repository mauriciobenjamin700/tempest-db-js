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

## Server-side notices (`onNotice`)

PostgreSQL emits a `NOTICE` for perfectly ordinary things — `CREATE TABLE IF NOT
EXISTS` on a table that exists, `DROP ... IF EXISTS` on one that does not, a
constraint whose index it creates for you. Every migration runner hits this.

The `postgres.js` driver prints those notices with `console.log` by default, which
drops a nine-line object into **your service's stdout**, in the middle of its
structured log, on every boot. tempest-db-js **silences** them by default and
gives you the hook:

```ts
const engine = createEngine(url, {
  onNotice: (notice) => logger.debug({ pg: notice }, "postgres notice"),
});
```

!!! info "Silence is the default on purpose"

    Writing to the host process's stdout is the application's decision, not a
    library's. Without `onNotice` the notice is dropped; with it, you choose the
    level, the shape and the destination.

An error thrown inside `onNotice` is swallowed, like `onQuery`.

## Driver options (`driverOptions`)

For what the typed layer does not model — postgres.js's `connection`, `types`,
`transform`, `ssl`, mysql2's own settings, `node:sqlite`'s `readOnly`:

```ts
const engine = createEngine(url, {
  pool: { size: 10 },
  driverOptions: { ssl: "require", transform: { undefined: null } },
});
```

`driverOptions` is applied **last** and wins over everything the library derives
(`pool` and `onNotice` included) — it is an escape hatch, so it gets the last
word.

## Recap

- `createEngine(url, { onQuery })` → per-statement `{ sql, params }` hook.
- `{ onNotice }` → server-side notices; **without it, nothing is printed**.
- A throwing logger is swallowed — never breaks the query.
- Driver failure → `QueryExecutionError` with `sql`, `params`, `cause`.
- `{ driverOptions }` passes through what the library does not model, applied last.
