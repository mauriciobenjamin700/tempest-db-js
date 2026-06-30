# Guide

The **Guide** gathers the reference and background material — the *how it works* and the
*what exists* — for when you've been through the [Tutorial](../tutorial/index.md) and want
to understand the design decisions or look something up in the API.

## In this section

| Page | What it covers |
| --- | --- |
| [Architecture](../architecture.md) | Why a column is a value, the active-record trade-off, how builders become AST + phantom types, and the module map. |
| [Repository](../repository.md) | `BaseRepository<Model>` — typed CRUD + pagination, the 404 convention, relations (eager-loading, no N+1), and how to extend it for your domain. |
| [Migrations](../migrations.md) | Alembic-style system: Schema IR, diff, codegen, DAG graph, runner, SQLite batch-mode, drift, and CLI. |
| [API reference](../reference.md) | The whole public surface in one place: `column`, `select`/`insert`/`update`/`del`, engine/session, joins, relations, serialization, migrations. |

## Where to start

- Want to **understand the choices** behind tempest-db-js? → [Architecture](../architecture.md).
- Building a **service data layer**? → [Repository](../repository.md).
- Need to **evolve the schema** safely? → [Migrations](../migrations.md).
- Just **looking up a function**? → [API reference](../reference.md).

!!! tip "Looking for hands-on examples?"

    The Guide explains the concepts; to see everything running together, head to the
    [Examples](../examples/index.md), and to solve a one-off problem, the
    [Recipes](../recipes/index.md).
