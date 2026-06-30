# Paginação tipada

**Problema:** listar tudo de uma vez não escala. Você quer páginas — com o total de
itens e o número de páginas — e quer isso **tipado**, sem montar `LIMIT`/`OFFSET` e
contagens na mão toda vez.

**Solução:** o `BaseRepository<Model>` já traz `paginate(...)`. O `orderBy` é uma coluna
**tipada** do modelo, e o resultado tem a mesma forma do `BasePaginationSchema<T>` do
`tempest-fastapi-sdk` — então o payload é idêntico entre um backend Python e um TS.

## A teoria em uma frase

`paginate` faz duas queries: um `COUNT(*)` (com os mesmos filtros) pro total, e um
`SELECT ... LIMIT pageSize OFFSET (page-1)*pageSize` pros itens da página. Devolve os
dois juntos, mais os metadados que o front precisa.

## Setup

```ts
import { Model, column, BaseRepository, createEngine } from "tempest-db-js";

class Product extends Model {
  static tablename = "products";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  price = column.numeric(10, 2).notNull(); // → string (decimal exato)
  active = column.boolean().notNull();
}

const engine = createEngine("sqlite:///shop.db");
const products = new BaseRepository(Product, engine.session());
```

## Paginar

```ts
const page = await products.paginate({
  page: 1,
  pageSize: 20,
  orderBy: "price",      // coluna tipada — "prices" não compila
  ascending: false,      // mais caro primeiro
  filters: { active: true, price: { gte: "10.00" } },
});

// page === {
//   items: ProductRow[],   // os 20 da página
//   total: number,         // total que casa com o filtro
//   page: 1,
//   pageSize: 20,
//   pages: number,         // Math.ceil(total / pageSize)
// }
```

!!! check "`orderBy` é checado em tempo de compilação"

    ```ts
    // ❌ erro: "prices" não é coluna de Product
    await products.paginate({ page: 1, pageSize: 20, orderBy: "prices", ascending: true });
    ```

    Um erro de digitação no campo de ordenação vira erro de compilação, não um
    `500` em produção.

## Servindo numa rota HTTP

Como o `PaginationResult` é JSON-safe na estrutura, dá pra devolver direto:

```ts
// pseudo-rota (veja o exemplo REST API pra um app completo)
async function listProducts(query: { page?: number; size?: number }) {
  return products.paginate({
    page: query.page ?? 1,
    pageSize: query.size ?? 20,
    orderBy: "name",
    ascending: true,
    filters: { active: true },
  });
}
```

!!! info "Mesma forma do SDK Python"

    `PaginationFilter` espelha o `BasePaginationFilterSchema` e `PaginationResult` o
    `BasePaginationSchema<T>` do [`tempest-fastapi-sdk`](https://pypi.org/project/tempest-fastapi-sdk/).
    Um cliente que já consome um backend Python paginado **não precisa mudar nada** pra
    consumir um backend TS feito com tempest-db-js.

## Recap

- `repository.paginate({ page, pageSize, orderBy, ascending, filters })`.
- `orderBy` é uma coluna tipada do modelo — typo = erro de compilação.
- Resultado: `{ items, total, page, pageSize, pages }`.
- Estrutura idêntica ao `BasePaginationSchema<T>` do `tempest-fastapi-sdk`.
