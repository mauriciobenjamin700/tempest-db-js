# Inserir, atualizar, deletar

Ler é metade da história. Agora vamos **escrever** — e ver como o tempest-db-js usa o
sistema de tipos pra evitar um erro clássico: apagar uma tabela inteira sem querer.

## INSERT

`insert(Model).values(...)` é tipado por `InferInsert` (lembra da página de
[Modelos](models.md): PK e defaults são opcionais):

```ts
import { insert } from "tempest-db-js";

insert(User).values({ name: "Ben", age: 30, nickname: null });
```

Faltou uma coluna obrigatória? Erro de compilação:

```ts
// ❌ erro: `age` é obrigatório
insert(User).values({ name: "Ben", nickname: null });
```

### Inserir várias linhas

`values` aceita uma linha ou um array:

```ts
insert(User).values([
  { name: "Ana", age: 22, nickname: null },
  { name: "Beto", age: 41, nickname: "B" },
]);
```

### `.returning()` — recuperar o que foi inserido

Sem `returning`, o resultado da execução (Fase 4) é o **número de linhas afetadas**.
Com `returning`, é a linha (ou uma projeção dela):

```ts
// linha completa
const full = insert(User)
  .values({ name: "x", age: 1, nickname: null })
  .returning();
// resultado inferido: UserRow

// só algumas colunas
const onlyId = insert(User)
  .values({ name: "x", age: 1, nickname: null })
  .returning(["id"]);
// resultado inferido: { id: number }
```

## UPDATE — e o guard de segurança

`update(Model).set(...)` define as colunas a alterar (parcial — só as informadas
mudam):

```ts
import { update } from "tempest-db-js";

update(User).set({ age: 31 }).where({ id: 1 });
```

`set` valida as colunas:

```ts
// ❌ erro: `bogus` não é coluna
update(User).set({ bogus: 1 });
```

### O guard tipado contra full-table writes

Aqui está a parte importante. Um `UPDATE` **sem `WHERE`** altera **todas as linhas**
— quase sempre um acidente. O tempest-db-js modela isso **no tipo**: um update começa no
estado `Guarded = false` e só vira **executável** depois de um `.where(...)`:

```ts
const safe = update(User).set({ age: 31 }).where({ id: 1 });
//    ^ Guarded = true  → o session.execute (Fase 4) aceita

const unsafe = update(User).set({ age: 0 });
//    ^ Guarded = false → o session.execute vai REJEITAR em tempo de compilação
```

Precisa mesmo atualizar a tabela inteira? Diga isso **explicitamente** com
`.unguarded()` — fica óbvio na revisão de código que foi intencional:

```ts
const all = update(User).set({ age: 0 }).unguarded();
//    ^ Guarded = true  → liberado, mas de propósito
```

!!! danger "Por que isso importa"

    `UPDATE users SET age = 0` sem `WHERE` zera a idade de todo mundo. Em outros
    ORMs isso compila sem reclamar. No tempest-db-js, ou você filtra com `.where()`, ou
    declara `.unguarded()` na cara — não tem caminho silencioso pro desastre.

## DELETE — mesmo guard

`del(Model)` (o nome é `del` porque `delete` é palavra reservada em JS) segue
exatamente a mesma regra:

```ts
import { del } from "tempest-db-js";

del(User).where({ id: 1 });        // ✅ guarded, seguro
del(User).unguarded();             // ✅ apaga tudo, mas de propósito
del(User);                         // ⚠️ Guarded = false → execução rejeitada
```

`returning` também funciona em delete:

```ts
const removed = del(User).where({ id: 1 }).returning(["name"]);
// resultado inferido: { name: string }
```

## Recap

- `insert(Model).values(...)` — tipado por `InferInsert`; aceita 1 ou N linhas.
- `.returning()` → linha completa; `.returning([cols])` → `Pick`.
- `update(Model).set(...)` valida as colunas; é parcial.
- **Guard tipado**: `update`/`del` só executam após `.where()` ou `.unguarded()`
  explícito — full-table write acidental vira erro de compilação.
- `del` é o `delete` (palavra reservada).

Agora que você sabe montar todas as queries, vamos **executá-las** contra um banco
de verdade. 👉 **[Executando queries](execution.md)**
