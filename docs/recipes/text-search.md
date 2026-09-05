# Busca de texto

Duas camadas, porque respondem perguntas diferentes.

## Camada 1: `contains` — substring escapada, igual em todo banco

```ts
import { contains, select } from "tempest-db-js";

session.execute(select(User).where(contains(["name", "email"], termo)));
```

- O termo é **tokenizado**: `"ana silva"` exige `ana` **e** `silva`, cada um podendo
  aparecer em qualquer das colunas. Digitar mais palavras estreita o resultado, que é o
  que uma caixa de busca precisa.
- Cada token é **escapado**. Sem índice, sem extensão, sem migração.
- `{ match: "any" }` troca o "todos" por "qualquer um".

!!! danger "`ilike` cru transforma `100%` em "tudo""

    `%` e `_` são curingas do `LIKE`. Passar o que o usuário digitou direto para
    `{ ilike: termo }` faz `100%` casar com **toda linha** da tabela:

    ```ts
    where({ title: { ilike: "100%" } })          // ❌ casa tudo
    where({ title: { iContains: "100%" } })      // ✅ casa "100%" literal
    where(contains(["title"], "100%"))           // ✅ idem, em várias colunas
    ```

    O operador `iContains` recebe **texto**, não padrão: ele escapa e monta o
    `%…%` sozinho. Para montar um padrão à mão, escape com `escapeLike(termo)`.

!!! info "O `ESCAPE '\'` não é decoração"

    O PostgreSQL já trata `\` como caractere de escape por padrão; o **SQLite não tem
    nenhum** até alguém declarar. Sem a cláusula `ESCAPE`, o escape feito do nosso lado
    não significaria nada lá — por isso ela é sempre emitida.

## Camada 2: `fullText` — stemming e ranking no PostgreSQL

```ts
const termo = "comprar";
session.execute(
  select(Post)
    .where(fullText(["title", "body"], termo, { language: "portuguese" }))
    .orderBy(fullTextRank(["title", "body"], termo, { language: "portuguese" }), "desc"),
);
```

No PostgreSQL vira `to_tsvector(...) @@ websearch_to_tsquery(...)`: **stemming**
(`comprar` acha "comprou"), remoção de stop word, e a sintaxe de aspas e `-exclusão`
que o usuário já conhece de buscador. `fullTextRank` vira `ts_rank`.

!!! warning "Fora do PostgreSQL, cai para a camada 1 — de propósito"

    No SQLite (e no MySQL) `fullText` compila como `contains`: **as linhas certas, sem
    stemming**. Um banco de desenvolvimento continua funcionando, e a diferença é
    qualidade de ranking, não corretude.

    `fullTextRank` vira uma constante nesses bancos, então ordenar por ele é inócuo — o
    ranking é a parte que realmente não existe sem motor de busca.

!!! tip "`coalesce` em toda coluna"

    O documento é `coalesce(col, '')` concatenado. Em SQL, um `NULL` no meio de uma
    concatenação faz o **documento inteiro** virar `NULL` — uma coluna vazia excluiria a
    linha da busca sem avisar.

## Índice

`fullText` sem índice funciona, mas varre a tabela. Em produção, crie o índice GIN
sobre a **mesma** expressão:

```sql
CREATE INDEX ix_posts_fts ON posts
  USING GIN (to_tsvector('portuguese', coalesce(title, '') || ' ' || coalesce(body, '')));
```

## Recapitulando

- Caixa de busca ⇒ `contains` (ou o operador `iContains`).
- Precisa de stemming e ranking no PostgreSQL ⇒ `fullText` + `fullTextRank`.
- `escapeLike` para quem monta padrão à mão.
- Fora do PostgreSQL, o full-text degrada para substring — documentado, não silencioso. 🚀
