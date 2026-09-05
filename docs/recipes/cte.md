# CTE (`WITH` e `WITH RECURSIVE`)

Uma CTE dá **nome** a uma consulta, para o resto do statement selecionar dela — e, na
forma recursiva, para ela selecionar de **si mesma**. A segunda forma é a única maneira de
percorrer uma árvore (categorias, cadeia de respostas, grafo de dependência) numa query só
em vez de uma por nível.

## Nomeando uma consulta

```ts
import { cte, select } from "tempest-db-js";

const recentes = cte("recentes", Order, select(Order).where({ createdAt: { gte: ontem } }));

const rows = await session.execute(recentes.select().where({ status: "open" })).all();
// WITH "recentes" AS (SELECT * FROM "orders" WHERE ...) SELECT * FROM "recentes" WHERE ...
```

`cte(...).model` é um **model de verdade** com o nome da CTE como tabela, então ele
funciona em tudo que já aceita model — `select`, `join`, `where` — sem caso especial em
lugar nenhum.

## Percorrendo uma árvore

```ts
import { cteRecursive, join, select, unionAll } from "tempest-db-js";

const subarvore = cteRecursive("subarvore", Category, (self) =>
  unionAll(
    select(Category).where({ id: raiz }),                                   // (1)!
    join(Category, "c").innerJoin(self, "s", { "c.parentId": "s.id" }).pick("c"),  // (2)!
  ),
);

const rows = await session.execute(subarvore.select().orderBy("id")).all();
```

1. **Semente**: por onde a recursão começa.
2. **Passo**: junta a tabela com a própria CTE. `.pick("c")` projeta **só** a categoria,
   com nomes de coluna simples — as colunas de um ramo de `UNION` precisam bater com as
   da CTE, e a linha composta de um join (`"c.id"`, `"s.id"`) não bate.

!!! danger "A recursão é sua para limitar"

    Nada impede um ciclo (`a` é pai de `b` que é pai de `a`) de rodar para sempre. Se o
    grafo pode ter ciclo, carregue a profundidade na própria CTE e corte:
    `where({ depth: { lt: 10 } })` no passo. O banco não vai adivinhar.

!!! info "A referência recursiva vai no `FROM`, não numa subquery"

    `WHERE parentId IN (SELECT id FROM subarvore)` **não** é uma CTE recursiva válida — o
    PostgreSQL recusa com "recursive reference must not appear within a subquery". Por
    isso o passo é um join.

!!! tip "`unionAll` quando a árvore não tem ciclo"

    `UNION` deduplica, e deduplicar custa. Numa árvore de verdade cada linha aparece uma
    vez só, então `unionAll` entrega o mesmo resultado mais barato.

## Materialização (PostgreSQL 12+)

```ts
cte("pesada", Order, corpo, { materialized: true });
```

Do PostgreSQL 12 em diante, uma CTE usada **uma vez** é inlined — quase sempre o que se
quer. `materialized: true` fixa o comportamento antigo quando o corpo é caro e usado duas
vezes; `false` força o inline. Onde o dialeto não tem a sintaxe, a opção é ignorada.

## Recapitulando

- `cte(nome, Model, corpo)` nomeia; `.select()` já traz o `WITH` junto.
- `cteRecursive(nome, Model, (self) => …)` percorre árvore numa query só.
- `.pick(alias)` faz um join caber onde um `SELECT` de uma tabela cabe.
- Limite de profundidade é responsabilidade sua. 🚀
