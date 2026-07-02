# REST API (Express + Repository)

A mesma API de produtos da receita [Hono](rest-api.md), agora sobre
[Express](https://expressjs.com) — o framework HTTP mais difundido do Node. O
`BaseRepository` continua sendo a **camada de dados**; só muda a casca HTTP.

!!! info "O padrão é o mesmo em qualquer framework"

    Repository + paginação tipada + convenção 404 não dependem do Express. Troque
    a casca (Hono, Fastify, Nest…) e a camada de dados fica idêntica.

## 1. Modelo + repositório

```ts
import { BaseRepository, Model, column, createEngine, sql } from "tempest-db-js";

class Product extends Model {
  static tablename = "products";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  price = column.numeric(10, 2).notNull(); // → string (decimal exato)
  active = column.boolean().notNull().default(true);
  createdAt = column.datetime().notNull().default(sql.now());
}

const engine = createEngine("sqlite:///shop.db");

class ProductRepository extends BaseRepository<typeof Product> {
  constructor() {
    super(Product, engine.session());
  }

  /** Só produtos ativos, mais novos primeiro. */
  listActive() {
    return this.list({ active: true });
  }
}

const products = new ProductRepository();
```

(Para criar a tabela, use o [fluxo de migrações](migrations-workflow.md).)

## 2. As rotas

```ts
import { RecordNotFound } from "tempest-db-js";
import express from "express";

const app = express();
app.use(express.json());

// LISTA paginada — GET /products?page=1&size=20
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

// DETALHE — GET /products/:id  → 404 se não existir
app.get("/products/:id", async (req, res, next) => {
  try {
    const product = await products.getById(Number(req.params.id));
    res.json(product);
  } catch (err) {
    if (err instanceof RecordNotFound) return res.status(404).json({ error: "not found" });
    next(err);
  }
});

// CRIA — POST /products
app.post("/products", async (req, res) => {
  const created = await products.create({ name: req.body.name, price: req.body.price });
  res.status(201).json(created); // linha criada, já tipada
});

// ATUALIZA — PATCH /products/:id
app.patch("/products/:id", async (req, res) => {
  const affected = await products.update({ id: Number(req.params.id) }, req.body);
  affected ? res.status(204).end() : res.status(404).json({ error: "not found" });
});

// REMOVE — DELETE /products/:id
app.delete("/products/:id", async (req, res) => {
  const affected = await products.delete({ id: Number(req.params.id) });
  affected ? res.status(204).end() : res.status(404).json({ error: "not found" });
});

app.listen(3000);
```

## 3. A convenção 404, explicada

!!! check "Único lança; coleção devolve `[]`"

    - `getById(id)` lança **`RecordNotFound`** quando não acha → responda `404`.
      Você pediu *um* recurso específico que não existe.
    - `list(filters)` / `paginate(...)` devolvem **`[]`** / `items: []` quando nada
      casa → responda `200`. "Nenhum resultado" é sucesso, não erro.

    É a mesma convenção do GitHub/Stripe/AWS e do `tempest-fastapi-sdk`.

## Recap

- A camada de dados (`BaseRepository`) é idêntica à da receita Hono — só a casca
  HTTP muda.
- `paginate` devolve o payload pronto pro front (`items`/`total`/`pages`).
- `getById` lança `RecordNotFound` → 404; coleções vazias → `[]` + 200.
