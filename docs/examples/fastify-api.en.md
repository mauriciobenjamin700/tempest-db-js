# REST API (Fastify + Repository)

The products API from the [Hono](rest-api.md) and [Express](express-api.md)
recipes, now on [Fastify](https://fastify.dev) — performance- and schema-first
focused. The `BaseRepository` remains the **data layer**.

!!! tip "Fastify + types"

    Fastify types `params`/`body`/`querystring` per route via generics. It pairs
    well with the repository's already-typed returns (`ProductRow`,
    `PaginationResult`).

## 1. Model + repository

```ts
import { BaseRepository, Model, column, createEngine, sql } from "tempest-db-js";

class Product extends Model {
  static tablename = "products";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  price = column.numeric(10, 2).notNull(); // → string (exact decimal)
  active = column.boolean().notNull().default(true);
  createdAt = column.datetime().notNull().default(sql.now());
}

const engine = createEngine("sqlite:///shop.db");

class ProductRepository extends BaseRepository<typeof Product> {
  constructor() {
    super(Product, engine.session());
  }

  listActive() {
    return this.list({ active: true });
  }
}

const products = new ProductRepository();
```

(To create the table, use the [migrations workflow](migrations-workflow.md).)

## 2. The routes

```ts
import { RecordNotFound } from "tempest-db-js";
import Fastify from "fastify";

const app = Fastify();

// LIST paginated — GET /products?page=1&size=20
app.get<{ Querystring: { page?: number; size?: number } }>(
  "/products",
  async (req) => {
    return products.paginate({
      page: Number(req.query.page ?? 1),
      pageSize: Number(req.query.size ?? 20),
      orderBy: "createdAt",
      ascending: false,
      filters: { active: true },
    }); // { items, total, page, pageSize, pages }
  },
);

// DETAIL — GET /products/:id  → 404 if missing
app.get<{ Params: { id: number } }>("/products/:id", async (req, reply) => {
  try {
    return await products.getById(Number(req.params.id));
  } catch (err) {
    if (err instanceof RecordNotFound) return reply.code(404).send({ error: "not found" });
    throw err;
  }
});

// CREATE — POST /products
app.post<{ Body: { name: string; price: string } }>(
  "/products",
  async (req, reply) => {
    const created = await products.create({ name: req.body.name, price: req.body.price });
    return reply.code(201).send(created);
  },
);

// UPDATE — PATCH /products/:id
app.patch<{ Params: { id: number }; Body: { price?: string; active?: boolean } }>(
  "/products/:id",
  async (req, reply) => {
    const affected = await products.update({ id: Number(req.params.id) }, req.body);
    return affected ? reply.code(204).send() : reply.code(404).send({ error: "not found" });
  },
);

// DELETE — DELETE /products/:id
app.delete<{ Params: { id: number } }>("/products/:id", async (req, reply) => {
  const affected = await products.delete({ id: Number(req.params.id) });
  return affected ? reply.code(204).send() : reply.code(404).send({ error: "not found" });
});

await app.listen({ port: 3000 });
```

## 3. The 404 convention, explained

!!! check "Single throws; collection returns `[]`"

    - `getById(id)` throws **`RecordNotFound`** when nothing matches → reply `404`.
    - `list(filters)` / `paginate(...)` return **`[]`** / `items: []` when nothing
      matches → reply `200`.

    Same convention as GitHub/Stripe/AWS and `tempest-fastapi-sdk`.

## Recap

- The data layer is the same as the Hono and Express recipes — only the shell
  changes.
- Fastify types `Params`/`Body`/`Querystring` per route; combine with the
  repository types for an end-to-end typed route.
- `getById` throws `RecordNotFound` → 404; empty collections → `[]` + 200.
