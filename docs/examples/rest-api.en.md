# REST API (Hono + Repository)

A products HTTP API, showing how `BaseRepository` becomes the **data layer** of a web
service — with typed pagination and the 404 convention (throw on a single record, `[]` on
a collection). We use [Hono](https://hono.dev) as the HTTP layer, but the pattern is the
same in Express, Fastify or any framework.

!!! info "The bridge to the ecosystem"

    `BaseRepository<Model>` mirrors the `BaseRepository` of
    [`tempest-fastapi-sdk`](https://pypi.org/project/tempest-fastapi-sdk/). A TS service
    built this way exposes the **same payload shape** as one of our Python backends — it's
    the foundation of the upcoming `tempest-ts-sdk`.

## 1. Model + repository

```ts
import { Model, column, sql, BaseRepository, createEngine } from "tempest-db-js";

class Product extends Model {
  static tablename = "products";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  price = column.numeric(10, 2).notNull();   // → string (exact decimal)
  active = column.boolean().notNull().default(true);
  createdAt = column.datetime().notNull().default(sql.now());
}

const engine = createEngine("sqlite:///shop.db");

// A domain repository: extends BaseRepository and gains its own methods.
class ProductRepository extends BaseRepository<typeof Product> {
  constructor() {
    super(Product, engine.session());
  }

  /** Active products only, newest first. */
  listActive() {
    return this.list({ active: true }); // Promise<ProductRow[]>
  }
}

const products = new ProductRepository();
```

(To create the table, use the [migrations workflow](migrations-workflow.en.md).)

## 2. The routes

```ts
import { Hono } from "hono";
import { RecordNotFound } from "tempest-db-js";

const app = new Hono();

// LIST paginated — GET /products?page=1&size=20
app.get("/products", async (c) => {
  const page = Number(c.req.query("page") ?? 1);
  const size = Number(c.req.query("size") ?? 20);
  const result = await products.paginate({
    page,
    pageSize: size,
    orderBy: "createdAt",
    ascending: false,
    filters: { active: true },
  });
  return c.json(result); // { items, total, page, pageSize, pages }
});

// DETAIL — GET /products/:id  → 404 if it doesn't exist
app.get("/products/:id", async (c) => {
  try {
    const product = await products.getById(Number(c.req.param("id")));
    return c.json(product);
  } catch (err) {
    if (err instanceof RecordNotFound) return c.json({ error: "not found" }, 404);
    throw err;
  }
});

// CREATE — POST /products
app.post("/products", async (c) => {
  const body = await c.req.json<{ name: string; price: string }>();
  const created = await products.create({ name: body.name, price: body.price });
  return c.json(created, 201); // created row, already typed
});

// UPDATE — PATCH /products/:id
app.patch("/products/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const patch = await c.req.json<{ price?: string; active?: boolean }>();
  const affected = await products.update({ id }, patch);
  return affected ? c.body(null, 204) : c.json({ error: "not found" }, 404);
});

// DELETE — DELETE /products/:id
app.delete("/products/:id", async (c) => {
  const affected = await products.delete({ id: Number(c.req.param("id")) });
  return affected ? c.body(null, 204) : c.json({ error: "not found" }, 404);
});

export default app;
```

## 3. The 404 convention, explained

!!! check "Single throws; collection returns `[]`"

    - `getById(id)` throws **`RecordNotFound`** when it doesn't find it → respond `404`. It
      makes sense: you asked for *one* specific resource that doesn't exist.
    - `list(filters)` / `paginate(...)` return **`[]`** / `items: []` when nothing matches
      → respond `200`. "No results" is success, not an error.

    It's the same convention as GitHub/Stripe/AWS and `tempest-fastapi-sdk`. Don't invent a
    `ProductsNotFoundError` for an empty list.

## 4. Why `price` is a `string`

`column.numeric(10, 2)` maps to a **`string`**, not `number` — JavaScript has no exact
decimal, and stringifying preserves `"19.90"` instead of risking `19.8999…`. Treat prices
as strings end to end (input, database, output JSON).

## Recap

- Extend `BaseRepository<typeof Model>` to get CRUD + pagination + domain methods.
- `paginate` returns the frontend-ready payload (`items`/`total`/`pages`).
- `getById` throws `RecordNotFound` → 404; empty collections → `[]` + 200.
- The shape matches `tempest-fastapi-sdk` — clients don't change between Python and TS.
