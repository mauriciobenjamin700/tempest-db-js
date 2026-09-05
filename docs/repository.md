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

## Os métodos além do CRUD

| Método | Para quê |
| --- | --- |
| `existsExcluding(filtros, chave)` | unicidade **num update**: "outro registro já usa este e-mail?" |
| `bulkUpsert(linhas, { conflictColumns, update? })` | `ON CONFLICT` em lote, um statement |
| `softDelete(chave)` / `restore(chave)` | par do mixin `withSoftDelete` |
| `deleteBatch(chaves)` | `DELETE ... WHERE id IN (...)`, devolvendo a contagem |
| `changesSince({ since, cursor, limit })` | sync incremental (delta) para cliente offline |

### `existsExcluding`

```ts
if (await users.existsExcluding({ email }, userId)) {
  throw new EmailTaken();
}
```

`exists({ email })` acharia **a própria linha** sendo editada e reportaria conflito
falso.

### `bulkUpsert`

```ts
await settings.bulkUpsert(rows, { conflictColumns: ["key"] });
```

Numa gravação de N linhas o valor novo não pode ser literal — cada linha tem o seu. Por
isso o `SET` referencia a linha que está entrando: `sql.excluded("col")`, que vira
`excluded."col"` no PostgreSQL e no SQLite e `VALUES(col)` no MySQL. `update:` restringe
quais colunas são sobrescritas.

### `softDelete` / `restore`

Exigem a coluna `deletedAt` (do `withSoftDelete`). Sem ela, **lançam** nomeando o mixin —
em vez de gerar SQL contra coluna inexistente.

### `changesSince` — sync incremental

```ts
let cursor: string | null = null;
let since = clientWatermark;             // null na primeira sincronização
do {
  const page = await items.changesSince({ since, cursor, limit: 200 });
  apply(page.items);
  cursor = page.nextCursor;
  if (cursor === null) clientWatermark = page.serverTime;   // (1)!
} while (cursor !== null);
```

1. Guarde o **`serverTime`**, não o maior `updatedAt` que você viu.

!!! danger "A marca d'água é o `serverTime`, não o maior `updatedAt`"

    `serverTime` é lido **antes** da query rodar. Uma linha commitada enquanto a página
    era montada carrega timestamp posterior, então aparece no próximo pull. Usar o maior
    `updatedAt` recebido deixaria essa linha cair no vão entre as duas sincronizações —
    e sumir para sempre.

!!! info "Linha apagada volta como tombstone"

    Com o mixin de soft delete, a linha apagada **é retornada** com `deletedAt`
    preenchido. É assim que o cliente sabe apagar a cópia local; filtrar a exclusão
    deixaria a linha órfã no dispositivo para sempre.

!!! warning "`changesSince` precisa de índice"

    A query filtra e ordena por `updatedAt`. Sem índice nessa coluna, cada pull é um
    full scan.

## Multi-tenant: escopo que não dá para esquecer

Em base de schema compartilhado, todas as linhas moram na mesma tabela e um
`WHERE tenantId = ?` esquecido vaza dado de um cliente para outro. O problema não é o
predicado — é que **todo** ponto de query precisa lembrar dele.

```ts
const docs = new TenantScopedRepository(Doc, session, {
  column: "tenantId",
  id: currentTenant,
});

await docs.list({ status: "open" });   // ... AND "tenantId" = ?
await docs.create({ title: "novo" });  // tenantId preenchido
```

O predicado entra em **toda** leitura — `list`, `first`, `exists`, `count`, `getById`,
`paginate`, `cursorPaginate`, `update`, `delete` — porque os métodos passam por um único
ponto de escopo (`scopeFilters`), não porque cada um lembra.

!!! danger "Linha de outro tenant é "não encontrada", não "proibida""

    `getById` de uma linha de outro cliente devolve `RecordNotFound` — o mesmo que uma
    linha inexistente. Diferenciar os dois casos já seria vazamento: contaria que aquele
    id existe em outro lugar.

!!! warning "Escrever com outro tenant **lança**"

    ```ts
    await docs.create({ id: 5, tenantId: 2, title: "x" });
    // Error: Refusing to write docs.tenantId = 2 from a repository scoped to 1
    ```

    Sobrescrever em silêncio transformaria um bug do chamador em dado que parece
    deliberado.

!!! info "O filtro é somado, nunca substituído"

    Passar `{ tenantId: outro }` num filtro gera uma contradição que não casa nada — não
    uma janela para o outro tenant.

Modelo sem a coluna de tenant faz o construtor lançar: um escopo que casa nada em
silêncio é pior que escopo nenhum.

## Recap

- `new BaseRepository(Model, session)` — CRUD + paginação tipados.
- `getById` lança `RecordNotFound`; `list` retorna `[]` (convenção 404).
- Chave composta: `getById({ ... })` com a chave inteira; escalar lança.
- `paginate` devolve itens + metadados, com `orderBy` tipado.
- `PaginationFilter`/`PaginationResult` alinhados ao `tempest-fastapi-sdk`.
