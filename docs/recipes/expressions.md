# Expressões no `where` (funções e coluna vs coluna)

Comparar uma coluna com **outra coluna**, e aplicar função SQL dos dois lados —
para casar índice funcional em vez de fazer sequential scan.

## O problema

A forma objeto do `where` compara sempre `coluna <operador> valor`:

```ts
select(Order).where({ total: { gt: 100 } });   // coluna vs valor ✅
```

Duas coisas ficam de fora:

1. **Coluna vs coluna** — `WHERE total > paid` não é expressável.
2. **Função no lado da coluna** — um índice funcional como
   `CREATE INDEX ON users (lower(trim(email)))` fica inalcançável, então a query
   que deveria usá-lo vira scan.

## `col` — referência de coluna

```ts
import { col, select } from "tempest-db-js";

select(Order).where(col<OrderRow>("total").gt(col<OrderRow>("paid")));
// SELECT * FROM "orders" WHERE "total" > "paid"
```

Passe o tipo da linha (`col<OrderRow>(...)`) para o nome ser checado em tempo de
compilação, do mesmo jeito que `or<UserRow>(...)` já funciona.

!!! check "Respeita o mapeamento de nome"

    `col()` recebe o **nome da propriedade** e passa pelo mesmo mapa de
    [nomes de coluna](naming.md) que o resto do builder. Não é uma porta dos
    fundos para escrever o nome físico da coluna.

Um operando que **não** é expressão continua sendo ligado como parâmetro, então o
caso comum permanece seguro por padrão:

```ts
select(Order).where(col<OrderRow>("total").gte(100));
// WHERE "total" >= $1        params: [100]
```

## `fn` — funções SQL

```ts
import { fn, val, select } from "tempest-db-js";

select(AdminUser).where(fn.lower("username").eq(fn.lower(val(probe))));
// WHERE lower("username") = lower($1)
```

!!! warning "String em `fn.*` é **coluna**; valor precisa de `val()`"

    Um argumento de função tinha que significar uma coisa só, e coluna é o uso
    dominante (`fn.lower("username")`). Para comparar contra um literal, envolva
    em `val(...)` — que é também o que deixa explícito onde o parâmetro é ligado.

    Já nos **operadores** (`.eq()`, `.gt()`, …) o padrão é o oposto e igualmente
    seguro: qualquer coisa que não seja uma expressão vira parâmetro.

Funções aninham:

```ts
select(User).where(fn.lower(fn.trim("email")).eq(val(input.trim().toLowerCase())));
// WHERE lower(trim("email")) = $1
```

Portáveis nos três dialetos: `lower`, `upper`, `trim`, `length`, `abs`,
`coalesce`.

### Qualquer outra função: `fn.call`

```ts
select(Order).where(fn.call("date_trunc", val("day"), "createdAt").eq(val(day)));
// WHERE date_trunc($1, "created_at") = $2
```

!!! danger "O nome da função é interpolado"

    `fn.call` escreve o nome direto no statement, então ele é validado como
    identificador SQL simples e **nunca** pode vir de entrada do usuário. Os
    argumentos, esses, sempre passam pelo compilador de expressão.

    `date_trunc` é PostgreSQL, `strftime` é SQLite — `fn.call` não finge ser
    portável.

## Operadores disponíveis

`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `ieq`, `in`, `notIn`,
`between`, `isNull` — os mesmos nomes da forma objeto.

```ts
col<OrderRow>("total").between(10, 99);
fn.lower("email").ilike(val("%@acme.com"));
col<UserRow>("email").ieq(col<UserRow>("login"));   // lower(a) = lower(b)
```

!!! note "`in` e `between` ligam seus operandos"

    Esses operadores bindam a lista, então uma `Expression` ali seria serializada
    como parâmetro em vez de virar SQL. Passar uma levanta erro na hora:

    ```
    The "in" operator binds its operands, so it takes values, not expressions.
    ```

## Combina com o resto

```ts
import { and } from "tempest-db-js";

select(Order).where(
  and(col<OrderRow>("total").gt(col<OrderRow>("paid")), { status: "open" }),
);
// WHERE ("total" > "paid") AND ("status" = $1)
```

E em joins, a referência é `alias.propriedade`:

```ts
join(Order, "o")
  .innerJoin(Customer, "c", { "o.customerId": "c.id" })
  .where(col("o.email").eq(col("c.email")));
// WHERE "o"."email" = "c"."email"
```

## `CASE` — agregação condicional

`caseWhen` usa a **mesma** linguagem de `where` nos ramos, então não aparece uma
gramática nova só para o `CASE`:

```ts
import { caseWhen, col, select, sum, val } from "tempest-db-js";

const rows = await session
  .execute(
    select(Order).aggregate(["customer"], {
      pago: sum(caseWhen([[{ status: "paid" }, col("total")]], val(0))),
      tudo: sum("total"),
    }),
  )
  .all();
// SUM(CASE WHEN "status" = $1 THEN "total" ELSE $2 END) AS "pago"
```

Uma passada na tabela em vez de uma query por bucket. Agregação passou a aceitar
expressão justamente para isso — `sum`, `avg`, `min` e `max` recebem coluna **ou**
expressão.

Ramos são avaliados em ordem; sem `ELSE`, linha que não casa com nenhum vira `NULL`.
Valor solto num ramo é **ligado como parâmetro**, não interpolado.

## `CAST` — converter no banco

```ts
select(Event).where(cast("externalId", "integer").gt(9));
// WHERE CAST("externalId" AS INTEGER) > $1
```

O alvo vem de um vocabulário portátil, e cada dialeto renderiza o nome que ele aceita:

| Alvo | PostgreSQL | SQLite | MySQL |
| --- | --- | --- | --- |
| `integer` | `INTEGER` | `INTEGER` | `SIGNED` |
| `text` | `TEXT` | `TEXT` | `CHAR` |
| `numeric` | `NUMERIC` | `NUMERIC` | `DECIMAL` |
| `timestamp` | `TIMESTAMP` | `TEXT` | `DATETIME` |

!!! warning "`CAST` numa coluna esconde o índice dela"

    `CAST(col AS ...)` num `where` impede o índice comum de `col` de ser usado — o
    banco precisa converter linha a linha. Se a comparação é frequente, o certo é um
    **índice funcional** sobre a mesma expressão, ou consertar o tipo da coluna.

## `EXISTS` — "existe alguma?"

```ts
import { col, exists, notExists, select } from "tempest-db-js";

select(User).where(
  exists(select(Order).where({ userId: col("users.id"), status: "open" })),
);
// WHERE EXISTS (SELECT * FROM "orders" WHERE "userId" = "users"."id" AND "status" = $1)
```

`notExists` é o complemento — clientes **sem** pedido aberto.

!!! tip "`EXISTS` para existir, `IN` para pertencer"

    `EXISTS` correlacionado pode parar na **primeira** linha que casa; um `IN` sobre
    subquery materializa o conjunto antes de comparar. Quando a pergunta é "existe pelo
    menos uma?", `EXISTS` é a forma que o planner otimiza melhor.

### Coluna contra coluna, na forma objeto

`where({ userId: col("users.id") })` compara **duas colunas**. Antes, um valor desses na
forma objeto era ligado como parâmetro — a subquery comparava a coluna com a string
`"users.id"`. Agora o `where` aceita expressão tanto no valor solto quanto dentro do
operador (`{ total: { gt: col("orders.paid") } }`).

## Subquery escalar

```ts
const maior = select(Order, ["total"])
  .where({ userId: col("users.id") })
  .orderBy("total", "desc")
  .limit(1)
  .asSubquery("total");

select(User).where(scalar(maior).gt(100));
```

`scalar()` recebe o resultado de `.asSubquery(coluna)`, não um builder solto — é o que
fixa a projeção em **uma** coluna. Subquery escalar devolvendo duas colunas é erro de
runtime em todo banco; aqui é erro de compilação.

## Recap

- `col<Row>("coluna")` referencia uma coluna; comparar duas dá `WHERE a > b`.
- `fn.lower/upper/trim/length/abs/coalesce` são portáveis; `fn.call` cobre o resto
  sem prometer portabilidade.
- Em `fn.*`, string é **coluna** e valor vai em `val()`. Nos operadores, o padrão
  é valor.
- `in`/`between` recusam expressão em vez de serializá-la.
- Tudo passa pelo mapa de nomes de coluna e pela qualificação de join.
