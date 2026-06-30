# Typed pagination

**Problem:** listing everything at once doesn't scale. You want pages — with the total
number of items and the number of pages — and you want it **typed**, without assembling
`LIMIT`/`OFFSET` and counts by hand every time.

**Solution:** `BaseRepository<Model>` already ships `paginate(...)`. The `orderBy` is a
**typed** column of the model, and the result has the same shape as `tempest-fastapi-sdk`'s
`BasePaginationSchema<T>` — so the payload is identical between a Python and a TS backend.

## The theory in one sentence

`paginate` runs two queries: a `COUNT(*)` (with the same filters) for the total, and a
`SELECT ... LIMIT pageSize OFFSET (page-1)*pageSize` for the page's items. It returns both
together, plus the metadata the frontend needs.

## Setup

```ts
import { Model, column, BaseRepository, createEngine } from "tempest-db-js";

class Product extends Model {
  static tablename = "products";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  price = column.numeric(10, 2).notNull(); // → string (exact decimal)
  active = column.boolean().notNull();
}

const engine = createEngine("sqlite:///shop.db");
const products = new BaseRepository(Product, engine.session());
```

## Paginate

```ts
const page = await products.paginate({
  page: 1,
  pageSize: 20,
  orderBy: "price",      // typed column — "prices" won't compile
  ascending: false,      // most expensive first
  filters: { active: true, price: { gte: "10.00" } },
});

// page === {
//   items: ProductRow[],   // the 20 on the page
//   total: number,         // total matching the filter
//   page: 1,
//   pageSize: 20,
//   pages: number,         // Math.ceil(total / pageSize)
// }
```

!!! check "`orderBy` is checked at compile time"

    ```ts
    // ❌ error: "prices" is not a column of Product
    await products.paginate({ page: 1, pageSize: 20, orderBy: "prices", ascending: true });
    ```

    A typo in the order-by field becomes a compile error, not a `500` in production.

## Serving on an HTTP route

Since the structure of `PaginationResult` is JSON-safe, you can return it directly:

```ts
// pseudo-route (see the REST API example for a complete app)
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

!!! info "Same shape as the Python SDK"

    `PaginationFilter` mirrors `BasePaginationFilterSchema` and `PaginationResult` mirrors
    the `BasePaginationSchema<T>` of [`tempest-fastapi-sdk`](https://pypi.org/project/tempest-fastapi-sdk/).
    A client that already consumes a paginated Python backend **doesn't need to change anything**
    to consume a TS backend built with tempest-db-js.

## Recap

- `repository.paginate({ page, pageSize, orderBy, ascending, filters })`.
- `orderBy` is a typed column of the model — typo = compile error.
- Result: `{ items, total, page, pageSize, pages }`.
- Structure identical to `tempest-fastapi-sdk`'s `BasePaginationSchema<T>`.
