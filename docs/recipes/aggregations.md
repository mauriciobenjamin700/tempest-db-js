# Agregações, GROUP BY e DISTINCT

Contar, somar e agrupar — tipado, sem escrever SQL.

## O problema

Você quer "quantos pedidos por status" ou "faturamento total por região". Isso é
`GROUP BY` + funções de agregação. tempest-db-js expõe isso com tipos fortes: o
resultado é uma linha com as **colunas de grupo** (tipadas pelo modelo) mais um
campo por **alias de agregação**.

## Contando linhas

```ts
import { Model, column, select, count, createSyncEngine } from "tempest-db-js";

class Order extends Model {
  static tablename = "orders";
  id = column.integer().primaryKey();
  status = column.text().notNull();
  amount = column.integer().notNull();
}

const session = createSyncEngine("sqlite:///shop.db").session();

// Agregação de tabela inteira: passe [] como groupBy.
const total = session.execute(select(Order).aggregate([], { n: count() })).scalar();
// total: number
```

!!! tip "`.scalar()` para um número só"

    Uma agregação de tabela inteira retorna **uma** linha. `.scalar()` pega o
    primeiro valor dela — perfeito para um `COUNT` avulso.

## Agrupando

```ts
import { count, sum } from "tempest-db-js";

const rows = session
  .execute(
    select(Order)
      .aggregate(["status"], { n: count(), total: sum("amount") })
      .orderBy("status"),
  )
  .all();
// rows: { status: string; n: number; total: number | null }[]
```

A linha tem `status` (coluna de grupo, tipada pelo modelo) + `n` e `total` (os
aliases). `count()` é sempre `number`; `sum`/`avg`/`min`/`max` são `number | null`
(null quando o grupo não tem valores).

## Filtrando antes de agrupar

`where` vem **antes** do `GROUP BY` — filtra as linhas que entram nos grupos:

```ts
select(Order)
  .where({ amount: { gt: 0 } })
  .aggregate(["status"], { total: sum("amount") });
// SELECT "status", SUM("amount") AS "total" FROM "orders" WHERE "amount" > ? GROUP BY "status"
```

## Os agregadores

| Helper | SQL | Tipo do resultado |
|---|---|---|
| `count()` | `COUNT(*)` | `number` |
| `sum("col")` | `SUM(col)` | `number \| null` |
| `avg("col")` | `AVG(col)` | `number \| null` |
| `min("col")` | `MIN(col)` | `number \| null` |
| `max("col")` | `MAX(col)` | `number \| null` |

!!! note "min/max são para colunas numéricas"

    `min`/`max` retornam `number | null`. Para colunas não-numéricas (texto,
    datas), o valor volta cru do driver — trate o tipo você mesmo.

## DISTINCT

Para eliminar linhas duplicadas, `.distinct()`:

```ts
const statuses = session
  .execute(select(Order, ["status"]).distinct().orderBy("status"))
  .all();
// SELECT DISTINCT "status" FROM "orders" ORDER BY "status"
```

## Recap

- `.aggregate(groupBy, spec)` → linha = colunas de grupo + aliases de agregação.
- `count` → `number`; `sum/avg/min/max` → `number | null`.
- `where` filtra antes do `GROUP BY`; `[]` como groupBy agrega a tabela toda.
- `.distinct()` emite `SELECT DISTINCT`.
