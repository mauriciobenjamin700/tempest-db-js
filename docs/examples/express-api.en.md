# REST API (Express + Repository)

The same products API as the [Hono](rest-api.md) recipe, now on
[Express](https://expressjs.com) — the most widespread Node HTTP framework. The
`BaseRepository` is still the **data layer**; only the HTTP shell changes.

!!! info "The pattern is the same in any framework"

    Repository + typed pagination + the 404 convention don't depend on Express.
    Swap the shell (Hono, Fastify, Nest…) and the data layer stays identical.

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

  /** Active products only, newest first. */
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
import express from "express";

const app = express();
app.use(express.json());

// LIST paginated — GET /products?page=1&size=20
app.get("/products", async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const size = Number(req.query.size ?? 20);
  const result = await products.paginate({
    page,
    pageSize: size,
    orderBy: "createdAt",
    ascending: false,
    filters: { active: true },
  });
  res.json(result); // { items, total, page, pageSize, pages }
});

// DETAIL — GET /products/:id  → 404 if missing
app.get("/products/:id", async (req, res, next) => {
  try {
    const product = await products.getById(Number(req.params.id));
    res.json(product);
  } catch (err) {
    if (err instanceof RecordNotFound) return res.status(404).json({ error: "not found" });
    next(err);
  }
});

// CREATE — POST /products
app.post("/products", async (req, res) => {
  const created = await products.create({ name: req.body.name, price: req.body.price });
  res.status(201).json(created); // created row, already typed
});

// UPDATE — PATCH /products/:id
app.patch("/products/:id", async (req, res) => {
  const affected = await products.update({ id: Number(req.params.id) }, req.body);
  affected ? res.status(204).end() : res.status(404).json({ error: "not found" });
});

// DELETE — DELETE /products/:id
app.delete("/products/:id", async (req, res) => {
  const affected = await products.delete({ id: Number(req.params.id) });
  affected ? res.status(204).end() : res.status(404).json({ error: "not found" });
});

app.listen(3000);
```

## 3. The 404 convention, explained

!!! check "Single throws; collection returns `[]`"

    - `getById(id)` throws **`RecordNotFound`** when nothing matches → reply `404`.
      You asked for *one* specific resource that doesn't exist.
    - `list(filters)` / `paginate(...)` return **`[]`** / `items: []` when nothing
      matches → reply `200`. "No results" is success, not an error.

    Same convention as GitHub/Stripe/AWS and `tempest-fastapi-sdk`.

## Recap

- The data layer (`BaseRepository`) is identical to the Hono recipe — only the
  HTTP shell changes.
- `paginate` returns a front-end-ready payload (`items`/`total`/`pages`).
- `getById` throws `RecordNotFound` → 404; empty collections → `[]` + 200.
