# Funções de janela

`GROUP BY` colapsa as linhas; janela **mantém** cada linha e anexa um valor calculado
sobre um grupo. É a diferença entre "quanto cada região vendeu" e "que posição esta venda
ocupa na região dela".

```ts
import { over, rowNumber, select, sum } from "tempest-db-js";

const rows = await session
  .execute(
    select(Sale, ["id", "region"]).compute({
      posicao: over(rowNumber(), { partitionBy: ["region"], orderBy: [["total", "desc"]] }),
      acumulado: over(sum("total"), {
        partitionBy: ["region"],
        orderBy: ["day"],
        frame: "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW",
      }),
    }),
  )
  .all();
// rows[0].posicao é number; rows[0].acumulado também
```

`compute()` projeta expressões por alias — e, ao contrário do `aggregate()`, **não
agrupa**: toda linha continua lá.

## As funções

| Função | O que dá |
| --- | --- |
| `rowNumber()` | 1, 2, 3 … sem empate |
| `rank()` | empate divide a posição e a próxima **pula** (1, 1, 3) |
| `denseRank()` | empate divide e a próxima **não pula** (1, 1, 2) |
| `percentRank()` | a posição como fração de 0 a 1 |
| `lag(col, n?)` / `lead(col, n?)` | valor de uma linha atrás / à frente |
| `firstValue(col)` / `lastValue(col)` | primeiro / último valor da janela |
| qualquer agregação | `over(sum("total"), …)`, `over(count(), …)` |

!!! danger "Função de janela sem `OVER` não compila — de propósito"

    ```ts
    select(Sale).compute({ anterior: lag("total") });   // ❌ erro de compilação
    ```

    `lag()` sem `OVER` é erro de runtime no banco ("misuse of window function"). Elas
    devolvem um `WindowFn`, que só `over()` aceita — o engano vira erro de tipo.

!!! warning "O frame padrão é `RANGE`, e ele agrupa os empates"

    Sem `frame`, o padrão do SQL é
    `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`: linhas com o **mesmo** valor de
    ordenação entram todas de uma vez, então um total corrido "salta" no empate. Quando
    isso importa, peça `ROWS` explicitamente, como no exemplo acima.

## Top N por grupo

```ts
const ranked = await session
  .execute(
    select(Sale, ["id", "region"]).compute({
      posicao: over(rowNumber(), { partitionBy: ["region"], orderBy: [["total", "desc"]] }),
    }),
  )
  .all();
const top = ranked.filter((r) => r.posicao <= 3);
```

!!! tip "Filtrar por janela precisa de outro nível"

    `WHERE` roda **antes** da janela ser calculada, então não dá para filtrar pelo alias
    na mesma query — em SQL isso pede subquery ou CTE. Filtrar no cliente (acima) resolve
    quando o conjunto é pequeno; para tabela grande, envolva a query numa
    [CTE](../recipes/) e filtre por fora.

## Recapitulando

- `compute({ alias: over(fn, spec) })` — a linha continua, o valor vem junto.
- `rowNumber`/`rank`/`denseRank`/`lag`/`lead`/… mais qualquer agregação.
- Sem `OVER` não compila; sem `frame` explícito o padrão é `RANGE`. 🚀
