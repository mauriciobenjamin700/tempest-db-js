# REST API (Fastify + Repository)

A API de produtos das receitas [Hono](rest-api.md) e [Express](express-api.md),
agora sobre [Fastify](https://fastify.dev) — foco em performance e schema-first. O
`BaseRepository` segue como a **camada de dados**.

!!! tip "Fastify + tipos"

    Fastify tipa `params`/`body`/`querystring` por rota via generics. Casa bem com
    o retorno já tipado do repositório (`ProductRow`, `PaginationResult`).

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
import Fastify from "fastify";

const app = Fastify();

// LISTA paginada — GET /products?page=1&size=20
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

// DETALHE — GET /products/:id  → 404 se não existir
app.get<{ Params: { id: number } }>("/products/:id", async (req, reply) => {
  try {
    return await products.getById(Number(req.params.id));
  } catch (err) {
    if (err instanceof RecordNotFound) return reply.code(404).send({ error: "not found" });
    throw err;
  }
});

// CRIA — POST /products
app.post<{ Body: { name: string; price: string } }>(
  "/products",
  async (req, reply) => {
    const created = await products.create({ name: req.body.name, price: req.body.price });
    return reply.code(201).send(created);
  },
);

// ATUALIZA — PATCH /products/:id
app.patch<{ Params: { id: number }; Body: { price?: string; active?: boolean } }>(
  "/products/:id",
  async (req, reply) => {
    const affected = await products.update({ id: Number(req.params.id) }, req.body);
    return affected ? reply.code(204).send() : reply.code(404).send({ error: "not found" });
  },
);

// REMOVE — DELETE /products/:id
app.delete<{ Params: { id: number } }>("/products/:id", async (req, reply) => {
  const affected = await products.delete({ id: Number(req.params.id) });
  return affected ? reply.code(204).send() : reply.code(404).send({ error: "not found" });
});

await app.listen({ port: 3000 });
```

## 3. A convenção 404, explicada

!!! check "Único lança; coleção devolve `[]`"

    - `getById(id)` lança **`RecordNotFound`** quando não acha → responda `404`.
    - `list(filters)` / `paginate(...)` devolvem **`[]`** / `items: []` quando nada
      casa → responda `200`.

    Mesma convenção do GitHub/Stripe/AWS e do `tempest-fastapi-sdk`.

## Recap

- A camada de dados é a mesma das receitas Hono e Express — só a casca muda.
- Fastify tipa `Params`/`Body`/`Querystring` por rota; combine com os tipos do
  repositório para ter a rota tipada ponta a ponta.
- `getById` lança `RecordNotFound` → 404; coleções vazias → `[]` + 200.
