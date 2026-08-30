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

## HAVING — filtrar pelo resultado da agregação

`where` filtra **linhas**, antes do agrupamento. Para filtrar **grupos**, pelo que
a agregação produziu, use `.having()`:

```ts
const heavy = session
  .execute(
    select(Order)
      .where({ status: "open" })          // (1)!
      .aggregate(["customer"], { n: count(), total: sum("amount") })
      .having({ n: { gt: 10 } }),         // (2)!
  )
  .all();
// SELECT "customer", COUNT(*) AS "n", SUM("amount") AS "total" FROM "orders"
//  WHERE "status" = $1 GROUP BY "customer" HAVING COUNT(*) > $2
```

1. Filtra as linhas que entram no agrupamento.
2. Filtra os grupos que saem dele. As chaves são os aliases que você nomeou, mais
   as colunas do `groupBy`.

!!! check "`.having()` sem `.aggregate()` é erro de compilação"

    O builder só ganha o método depois de agrupar, então a ordem errada falha no
    type-check em vez de virar SQL inválido em runtime.

!!! info "Por que o SQL sai com a expressão, não com o alias"

    O PostgreSQL **não** aceita alias de `SELECT` no `HAVING` — `HAVING n > 10`
    falha. O compilador reemite a expressão (`COUNT(*) > $2`), que funciona nos
    três dialetos. Você continua escrevendo o alias.

### Ordenar pelo alias

`ORDER BY`, ao contrário do `HAVING`, aceita o alias em todo dialeto — e o builder
o emite como escrito:

```ts
select(Order).aggregate(["customer"], { n: count() }).orderBy("n", "desc");
// ... GROUP BY "customer" ORDER BY "n" DESC
```

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
- `where` filtra antes do `GROUP BY`; `.having()` filtra depois, pelos aliases;
  `[]` como groupBy agrega a tabela toda.
- `.orderBy(alias)` ordena pelo resultado da agregação.
- `.distinct()` emite `SELECT DISTINCT`.
