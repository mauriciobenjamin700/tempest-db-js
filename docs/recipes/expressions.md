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

## Recap

- `col<Row>("coluna")` referencia uma coluna; comparar duas dá `WHERE a > b`.
- `fn.lower/upper/trim/length/abs/coalesce` são portáveis; `fn.call` cobre o resto
  sem prometer portabilidade.
- Em `fn.*`, string é **coluna** e valor vai em `val()`. Nos operadores, o padrão
  é valor.
- `in`/`between` recusam expressão em vez de serializá-la.
- Tudo passa pelo mapa de nomes de coluna e pela qualificação de join.
