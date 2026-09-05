# Repository

`BaseRepository<Model>` é uma camada CRUD + paginação **totalmente tipada** sobre um
modelo e uma sessão async — espelhando o `BaseRepository` do `tempest-fastapi-sdk`.
É a base de dados do futuro `tempest-ts-sdk`.

```ts
import { BaseRepository, createEngine } from "tempest-db-js";

const engine = createEngine("sqlite:///app.db");
const users = new BaseRepository(User, engine.session());
```

## CRUD

```ts
const user = await users.create({ name: "Ana", age: 30, active: true }); // linha criada
await users.createMany([{ name: "Beto", age: 40, active: false }]);

const one = await users.getById(user.id);          // lança RecordNotFound se ausente
const maybe = await users.getByIdOrNull(999);       // null se ausente
const first = await users.first({ active: true });  // linha | null
const all = await users.list({ age: { gte: 18 } }); // sempre [] quando nada casa

await users.update({ id: user.id }, { age: 31 });   // nº de linhas afetadas
await users.delete({ active: false });              // nº de linhas afetadas
```

!!! check "Convenção 404 honrada"

    `getById` lança `RecordNotFound` quando não acha (lookup de registro único). Mas
    métodos de coleção (`list`) retornam **`[]`** quando nada casa — "nenhum
    resultado" é sucesso, não erro. Igual GitHub/Stripe/AWS.

## Contagem e existência

```ts
await users.count();                  // total
await users.count({ active: true });  // total filtrado
await users.exists({ age: { gt: 65 } });
```

## Paginação tipada

```ts
const page = await users.paginate({
  page: 1,
  pageSize: 20,
  orderBy: "age",        // coluna tipada do modelo
  ascending: false,
  filters: { active: true },
});
// { items: UserRow[], total, page, pageSize, pages }
```

`PaginationFilter` e `PaginationResult` espelham `BasePaginationFilterSchema` e
`BasePaginationSchema<T>` do SDK Python, então a forma do payload é a mesma entre
backend Python e TS.

## Estendendo

Subclasse pra adicionar métodos de domínio — os tipos do modelo se propagam:

```ts
class UserRepository extends BaseRepository<typeof User> {
  constructor(session: AsyncSession) {
    super(User, session);
  }

  activeAdults() {
    return this.list({ active: true, age: { gte: 18 } }); // Promise<UserRow[]>
  }
}
```

## Relations (eager-load tipado)

Declare relações com `hasMany`/`belongsTo` e carregue-as com `loadRelations` — **uma
query por relação** (sem N+1). O tipo do resultado é ampliado: `hasMany` vira `Row[]`,
`belongsTo` vira `Row | null`.

```ts
import { hasMany, belongsTo, loadRelations, select } from "tempest-db-js";

const users = await session.execute(select(User)).all();
const withPosts = await loadRelations(session, users, {
  posts: hasMany(() => Post, { localKey: "id", foreignKey: "userId" }),
});
withPosts[0].posts; // PostRow[]

const posts = await session.execute(select(Post)).all();
const withAuthor = await loadRelations(session, posts, {
  author: belongsTo(() => User, { localKey: "userId", foreignKey: "id" }),
});
withAuthor[0].author; // UserRow | null
```

## Chave primária composta

Modelo com mais de uma coluna `primaryKey()` é identificado por **todas** elas.
`getById` recebe um objeto com a chave inteira:

```ts
class OrderLine extends Model {
  static override tablename = "order_lines";
  orderId = column.integer().primaryKey();
  lineNumber = column.integer().primaryKey();
  sku = column.varchar(40).notNull();
}

const lines = new BaseRepository(OrderLine, session);
const line = await lines.getById({ orderId: 1, lineNumber: 2 });
```

O mesmo vale para o active-record: `activeRecord(OrderLine, session).get({ orderId, lineNumber })`,
e `update`/`delete`/`reload` filtram pela chave inteira.

!!! danger "Escalar em chave composta é erro, não meia chave"

    ```ts
    await lines.getById(1);
    // Error: order_lines has a composite primary key (orderId, lineNumber);
    //        pass an object like { orderId, lineNumber } instead of a scalar.
    ```

    Um escalar não diz **qual** coluna da chave ele é. Antes disso valer um erro, o
    filtro saía com metade da chave (`WHERE orderId = 1`) e devolvia — ou atualizava —
    a linha errada quando o pedido tinha mais de uma linha.

    Chave incompleta (`{ orderId: 1 }`) também lança, nomeando a coluna que falta.

Chave de uma coluna continua aceitando o valor cru (`getById(7)`) **e** o objeto
(`getById({ id: 7 })`).

## Recap

- `new BaseRepository(Model, session)` — CRUD + paginação tipados.
- `getById` lança `RecordNotFound`; `list` retorna `[]` (convenção 404).
- Chave composta: `getById({ ... })` com a chave inteira; escalar lança.
- `paginate` devolve itens + metadados, com `orderBy` tipado.
- `PaginationFilter`/`PaginationResult` alinhados ao `tempest-fastapi-sdk`.
