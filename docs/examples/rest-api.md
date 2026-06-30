# REST API (Hono + Repository)

Uma API HTTP de produtos, mostrando como o `BaseRepository` vira a **camada de dados**
de um serviço web — com paginação tipada e a convenção 404 (lançar em registro único,
`[]` em coleção). Usamos [Hono](https://hono.dev) como camada HTTP, mas o padrão é o
mesmo em Express, Fastify ou qualquer framework.

!!! info "A ponte com o ecossistema"

    O `BaseRepository<Model>` espelha o `BaseRepository` do
    [`tempest-fastapi-sdk`](https://pypi.org/project/tempest-fastapi-sdk/). Um serviço TS
    feito assim expõe o **mesmo formato de payload** que um backend Python da casa — é a
    base do futuro `tempest-ts-sdk`.

## 1. Modelo + repositório

```ts
import { Model, column, sql, BaseRepository, createEngine } from "tempest-db-js";

class Product extends Model {
  static tablename = "products";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  price = column.numeric(10, 2).notNull();   // → string (decimal exato)
  active = column.boolean().notNull().default(true);
  createdAt = column.datetime().notNull().default(sql.now());
}

const engine = createEngine("sqlite:///shop.db");

// Um repositório de domínio: estende o BaseRepository e ganha métodos próprios.
class ProductRepository extends BaseRepository<typeof Product> {
  constructor() {
    super(Product, engine.session());
  }

  /** Só produtos ativos, mais novos primeiro. */
  listActive() {
    return this.list({ active: true }); // Promise<ProductRow[]>
  }
}

const products = new ProductRepository();
```

(Para criar a tabela, use o [fluxo de migrações](migrations-workflow.md).)

## 2. As rotas

```ts
import { Hono } from "hono";
import { RecordNotFound } from "tempest-db-js";

const app = new Hono();

// LISTA paginada — GET /products?page=1&size=20
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

// DETALHE — GET /products/:id  → 404 se não existir
app.get("/products/:id", async (c) => {
  try {
    const product = await products.getById(Number(c.req.param("id")));
    return c.json(product);
  } catch (err) {
    if (err instanceof RecordNotFound) return c.json({ error: "not found" }, 404);
    throw err;
  }
});

// CRIA — POST /products
app.post("/products", async (c) => {
  const body = await c.req.json<{ name: string; price: string }>();
  const created = await products.create({ name: body.name, price: body.price });
  return c.json(created, 201); // linha criada, já tipada
});

// ATUALIZA — PATCH /products/:id
app.patch("/products/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const patch = await c.req.json<{ price?: string; active?: boolean }>();
  const affected = await products.update({ id }, patch);
  return affected ? c.body(null, 204) : c.json({ error: "not found" }, 404);
});

// REMOVE — DELETE /products/:id
app.delete("/products/:id", async (c) => {
  const affected = await products.delete({ id: Number(c.req.param("id")) });
  return affected ? c.body(null, 204) : c.json({ error: "not found" }, 404);
});

export default app;
```

## 3. A convenção 404, explicada

!!! check "Único lança; coleção devolve `[]`"

    - `getById(id)` lança **`RecordNotFound`** quando não acha → responda `404`. Faz
      sentido: você pediu *um* recurso específico que não existe.
    - `list(filters)` / `paginate(...)` devolvem **`[]`** / `items: []` quando nada casa
      → responda `200`. "Nenhum resultado" é sucesso, não erro.

    É a mesma convenção do GitHub/Stripe/AWS e do `tempest-fastapi-sdk`. Não invente
    `ProductsNotFoundError` pra lista vazia.

## 4. Por que `price` é `string`

`column.numeric(10, 2)` mapeia pra **`string`**, não `number` — o JavaScript não tem
decimal exato, e stringificar preserva `"19.90"` em vez de arriscar `19.8999…`. Trate
preços como string de ponta a ponta (entrada, banco, JSON de saída).

## Recap

- Estenda `BaseRepository<typeof Model>` pra ter CRUD + paginação + métodos de domínio.
- `paginate` devolve o payload pronto pro front (`items`/`total`/`pages`).
- `getById` lança `RecordNotFound` → 404; coleções vazias → `[]` + 200.
- O formato bate com o `tempest-fastapi-sdk` — clientes não mudam entre Python e TS.
