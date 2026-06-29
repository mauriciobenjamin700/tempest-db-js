# Joins

Pra combinar tabelas, o tempest-db-js tem `join(...)` — e o resultado é um **tipo
composto**: um objeto com uma chave por tabela, cada uma com sua linha tipada.

## Passo 1 — O join básico

Comece pela tabela base com um **alias**, depois junte outras:

```ts
import { join } from "tempest-db-js";

const q = join(User, "user")
  .innerJoin(Order, "order", { "user.id": "order.userId" })
  .where({ "order.status": "paid" });
```

O resultado de `q` é inferido como:

```ts
{ user: UserRow; order: OrderRow }[]
```

Uma chave por alias, cada uma com a linha completa daquela tabela. Sem achatar
colunas, sem colisão de nomes (`user.id` e `order.id` convivem).

## Passo 2 — Referências `alias.column` tipadas

`on`, `where` e `orderBy` usam refs no formato `"alias.column"` — e elas são
**checadas em tempo de compilação**:

```ts
join(User, "user")
  .innerJoin(Order, "order", { "user.id": "order.userId" })  // ✅ colunas válidas
  .where({ "order.status": "paid" })                          // ✅
  .orderBy("order.amount", "desc");                           // ✅

// ❌ erro: `user.bogus` não é coluna de User
join(User, "user").innerJoin(Order, "order", { "user.bogus": "order.userId" });
```

## Passo 3 — `leftJoin` e nullability

Um `leftJoin` mantém as linhas da esquerda mesmo sem correspondência — então o lado
direito pode ser nulo. **O tipo reflete isso**: a chave joinada vira `Row | null`:

```ts
const q = join(User, "user").leftJoin(Order, "order", { "user.id": "order.userId" });
// resultado: { user: UserRow; order: OrderRow | null }[]
```

Na execução, uma linha sem match traz `order: null` — e o tipo te obriga a tratar
isso:

```ts
const rows = await session.execute(q).all();
for (const row of rows) {
  if (row.order) {
    console.log(row.user.name, row.order.amount); // `order` estreitado pra OrderRow
  } else {
    console.log(row.user.name, "sem pedidos");
  }
}
```

## Passo 4 — Vários joins

Encadeie quantos precisar; cada um adiciona uma chave ao tipo composto:

```ts
const q = join(User, "user")
  .innerJoin(Order, "order", { "user.id": "order.userId" })
  .leftJoin(Product, "product", { "order.productId": "product.id" });
// resultado: { user: UserRow; order: OrderRow; product: ProductRow | null }[]
```

## Como funciona por baixo

O dialeto compila as colunas com **alias** (`"user"."id" AS "user.id"`), então a
linha plana do driver é **dividida** de volta em `{ user: {...}, order: {...} }`,
coagindo cada lado pelo seu modelo. Pra `leftJoin`, quando todas as colunas do lado
direito vêm nulas, aquele lado vira `null`.

!!! note "Em evolução"

    Os operadores tipados-por-coluna (Fase 3) ainda não se aplicam ao `where` de
    join — hoje as chaves `alias.column` são tipadas, mas o valor aceita match ou
    operador sem restrição por tipo. Relations declarativas (`hasMany`/`belongsTo`)
    e combinadores `and`/`or` também estão no roadmap.

## Recap

- `join(Model, alias)` inicia; `.innerJoin`/`.leftJoin(Model, alias, on)` agregam.
- Resultado é composto: `{ [alias]: Row }`, uma chave por tabela.
- `leftJoin` torna o lado nullable (`Row | null`) — o tipo te força a tratar.
- `on`/`where`/`orderBy` usam refs `alias.column` tipadas.

Você cobriu o caminho principal do tempest-db-js! Veja a **[Referência](../reference.md)**
pra API completa e o **[Roadmap](../roadmap.md)** pro que vem (migrações, relations).
