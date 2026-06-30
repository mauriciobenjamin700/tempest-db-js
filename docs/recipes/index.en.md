# Recipes

The **recipes** solve one specific problem at a time — complete, copy-paste code,
with the theory of *why* right next to it. They are the practical complement to the
[Tutorial](../tutorial/index.en.md): the tutorial teaches you the concepts in order; the
recipes show you how to apply them in real day-to-day situations.

!!! tip "How to read this"

    Each recipe is independent — jump straight to what you need. They all assume you
    have already been through the [Tutorial](../tutorial/index.en.md) (models, queries, execution).

## Available

| Recipe | Solves |
| --- | --- |
| [created_at / updated_at](timestamps.en.md) | Database-managed timestamps, without remembering to set them by hand. |
| [Typed pagination](pagination.en.md) | Paginated lists with total/pages, aligned with `tempest-fastapi-sdk`. |
| [Transactions and savepoints](transactions.en.md) | Atomic operations with automatic commit/rollback and savepoints. |
| [JSON and enum columns](json-enum.en.md) | Store typed objects and literal unions with type safety. |
| [Serialization (row ↔ JSON)](serialization.en.md) | Convert rows to JSON and validate JSON back into a row. |
| [Connecting to PostgreSQL](postgres.en.md) | Swap SQLite for Postgres via the URL and tune the pool. |

## Looking for something bigger?

If you want to see it all put together in a project that runs, go to **[Examples](../examples/index.en.md)**:
a Todo CLI, a blog with relations, a REST API, and the complete migrations workflow.
