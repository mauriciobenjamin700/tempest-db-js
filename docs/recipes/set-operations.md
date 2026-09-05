# Operações de conjunto

`UNION`, `UNION ALL`, `INTERSECT` e `EXCEPT` combinam duas ou mais consultas — o que um
join não faz: aqui os ramos são **independentes** e podem vir de tabelas diferentes.

```ts
import { select, union } from "tempest-db-js";

const feed = union(
  select(Post, ["id", "createdAt"]).where({ authorId: me }),
  select(Comment, ["id", "createdAt"]).where({ authorId: me }),
)
  .orderBy("createdAt", "desc")
  .limit(50);

const rows = await session.execute(feed).all();
```

| Operador | O que faz |
| --- | --- |
| `union` | tudo dos ramos, **sem duplicata** |
| `unionAll` | tudo dos ramos, duplicatas **mantidas** |
| `intersect` | só o que aparece em **todos** os ramos |
| `except` | o do primeiro ramo que **não** está nos outros |

!!! tip "`unionAll` quando os ramos não se sobrepõem"

    `UNION` precisa ordenar ou hashear para remover duplicata. Se os conjuntos são
    disjuntos por construção, `unionAll` entrega o mesmo resultado sem esse custo.

## Forma verificada no tipo

```ts
union(
  select(Post, ["id", "title"]),
  select(Comment, ["id", "body"]),   // ❌ erro de compilação
);
```

Os ramos precisam projetar a **mesma** forma. É o erro que o banco só reporta em runtime
e que um builder tipado pega antes.

## `ORDER BY` e `LIMIT`: no conjunto, não no ramo

`.orderBy()` / `.limit()` / `.offset()` do resultado aplicam ao **combinado**, que é o que
o SQL faz. Um ramo com ordenação ou limite próprios é **parentetizado**:

```ts
union(
  select(Post, ["id"]).orderBy("createdAt", "desc").limit(3),   // (SELECT ... LIMIT 3)
  select(Comment, ["id"]),
);
```

Sem os parênteses, aquele `LIMIT` passaria a valer para o conjunto inteiro — uma query
diferente, e uma fonte clássica de resultado silenciosamente errado.

!!! warning "MySQL: `INTERSECT`/`EXCEPT` fora de escopo"

    O MySQL só ganhou os dois no 8.0.31, e este projeto não investe em MySQL além do que
    já funciona. Compilar `intersect`/`except` para MySQL **lança**, sugerindo join ou
    `NOT EXISTS`. `union`/`unionAll` funcionam normalmente.

## Recapitulando

- Quatro operadores, no mesmo builder executável do `select`.
- Forma dos ramos verificada em tempo de compilação.
- Ordenação e limite aplicam ao conjunto; ramo com os seus é parentetizado. 🚀
