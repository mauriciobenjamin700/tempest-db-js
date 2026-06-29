# Installation

## Requirements

- **Node.js ≥ 20** (or a compatible runtime).
- **TypeScript ≥ 5.7** — Querium relies on modern type-inference features. Older
  versions may not infer rows correctly.

!!! warning "Pre-alpha — not on npm yet"

    Querium is at `v0.0.0` and has **not been published** yet. The commands below
    are how installation will work once the first version ships. For now, use it
    via a local repository (see [Contributing](contributing.md)).

## Install

```bash
npm install querium
```

=== "npm"

    ```bash
    npm install querium
    ```

=== "pnpm"

    ```bash
    pnpm add querium
    ```

=== "yarn"

    ```bash
    yarn add querium
    ```

## Database drivers (peer dependencies)

Querium does **not** bundle a database driver — you pick and install the one you
need. The drivers are **optional** `peerDependencies`, so installing Querium
doesn't pull in any database.

| Database | Driver | Package |
| --- | --- | --- |
| SQLite | `better-sqlite3` | `npm install better-sqlite3` |
| PostgreSQL | `postgres` (postgres.js) | `npm install postgres` |

!!! info "Execution arrives in Phase 4"

    Today Querium builds the **typed AST** for queries, but it doesn't execute
    against a database yet — that's Phase 4 of the [Roadmap](roadmap.md). You can
    already install it and use the entire schema typing and query builder; the
    `session.execute` and the SQLite/PostgreSQL dialects come next.

## TypeScript configuration

Querium assumes a `tsconfig.json` in **strict** mode. The recommended minimum:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

!!! tip "Why `strict`?"

    Querium's inference is built on top of TS's strict type system. With
    `strict: false`, column nullability (`string | null`) and the UPDATE/DELETE
    guards lose their strength — exactly the guarantees you adopted a typed ORM
    for. Keep `strict: true`.

## Verify the installation

```ts
import { Model, column, select } from "querium";

class Ping extends Model {
  static tablename = "ping";
  id = column.integer().primaryKey();
}

const q = select(Ping);
console.log(q.node.table); // "ping"
```

If this compiles with `tsc --noEmit` without errors, you're all set. ✅

## Recap

- Node ≥ 20, TypeScript ≥ 5.7, `strict: true`.
- `npm install querium` — no bundled driver.
- Install `better-sqlite3` and/or `postgres` depending on your database.
- Next: build your first model in the **[Tutorial](tutorial/index.md)**.
