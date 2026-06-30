# Tutorial — Start here

Welcome! 🚀 This is tempest-db-js's **Tutorial — User Guide**. It's **linear**: each
page teaches **one concept**, building on the previous one, with complete examples
you can copy and paste. Start here and follow the "next page" links — you'll never
get stuck.

Throughout the tutorial we'll model **the same mini-domain**, page by page: a task
manager with users. No loose theory — each concept shows up because the domain
needs it.

## What is tempest-db-js?

It's an ORM for TypeScript where you declare your tables as **classes** and
TypeScript infers the shape of each row automatically. If you've used SQLAlchemy
2.0 in Python, you'll feel right at home:

=== "tempest-db-js (TypeScript)"

    ```ts
    import { Model, column } from "tempest-db-js";

    class User extends Model {
      static tablename = "users";
      id = column.integer().primaryKey();
      name = column.text().notNull();
    }
    ```

=== "SQLAlchemy (Python)"

    ```python
    from sqlalchemy.orm import Mapped, mapped_column

    class User(Base):
        __tablename__ = "users"
        id: Mapped[int] = mapped_column(primary_key=True)
        name: Mapped[str] = mapped_column()
    ```

The key difference: Python reads types at runtime; TypeScript erases types at
compile time. That's why, in tempest-db-js, **the column is a value**
(`column.integer()`) that carries the type — not an annotation. You'll understand
this well on the next page.

## Before you start

Make sure you have the prerequisites from [Installation](../installation.md):
Node ≥ 20, TypeScript ≥ 5.7, and `strict: true` in your `tsconfig.json`.

!!! info "The first pages don't even need a database"

    Declaring models and building `select`/`insert`/`update`/`delete` happens **at
    the type level** — you can follow along with just the TypeScript compiler.
    From **[Running queries](execution.md)** onward we connect a real SQLite (the
    built-in `node:sqlite`, zero install) and run everything against a database.

## The path

1. **[Models](models.md)** — declare tables as classes and infer the row types
   (`InferModel`, `InferInsert`).
2. **[Queries](queries.md)** — build a typed `SELECT`, with projection, filters,
   and ordering.
3. **[Insert, update, delete](mutations.md)** — typed `INSERT`/`UPDATE`/`DELETE`,
   including the guard that prevents accidentally wiping out an entire table.
4. **[Running queries](execution.md)** — create an engine, open a session, and
   **run the queries** against SQLite/PostgreSQL, with transactions and streaming.
5. **[Joins](joins.md)** — combine tables into composite types, with correct
   nullability on `leftJoin`.

Ready? Let's get to the first model. 👉 **[Models](models.md)**
