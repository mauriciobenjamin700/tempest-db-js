# Upsert (ON CONFLICT)

Inserir, mas resolver conflito de chave única em vez de estourar erro.

## O problema

Você insere uma linha cuja PK / coluna única já existe. Por padrão o banco
rejeita. Muitas vezes você quer: **ou** ignorar (mantém a existente), **ou**
sobrescrever (upsert). Isso é `ON CONFLICT`.

## DO NOTHING — ignora o conflito

```ts
import { Model, column, insert, createSyncEngine } from "tempest-db-js";

class Setting extends Model {
  static tablename = "settings";
  key = column.text().primaryKey();
  value = column.integer().notNull();
}

const session = createSyncEngine("sqlite:///app.db").session();

session.execute(
  insert(Setting).values({ key: "theme", value: 1 }).onConflictDoNothing(["key"]),
);
// Se "theme" já existe, a linha nova é descartada — sem erro.
```

## DO UPDATE — sobrescreve (upsert)

```ts
session.execute(
  insert(Setting)
    .values({ key: "theme", value: 2 })
    .onConflictDoUpdate(["key"], { value: 2 }),
);
// Se "theme" já existe, atualiza value = 2. Senão, insere.
```

O primeiro argumento é a(s) coluna(s) do conflito (uma constraint única/PK). O
segundo é o que sobrescrever quando há conflito.

!!! tip "Combine com RETURNING"

    `.returning()` funciona junto — pegue a linha final (inserida ou atualizada):

    ```ts
    const saved = session
      .execute(
        insert(Setting)
          .values({ key: "theme", value: 2 })
          .onConflictDoUpdate(["key"], { value: 2 })
          .returning(),
      )
      .one();
    ```

## Índice único parcial — o predicado do conflict target

No PostgreSQL, um **índice único parcial** só é reconhecido como alvo de
`ON CONFLICT` se a query repetir o predicado do índice. Sem isso o banco responde
`there is no unique or exclusion constraint matching the ON CONFLICT specification`.

```sql
CREATE UNIQUE INDEX outbound_idempotency_unique
    ON outbound_messages (consumer, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
```

```ts
insert(Outbound)
  .values(message)
  .onConflictDoNothing(["consumer", "idempotencyKey"], {
    where: { idempotencyKey: { isNull: false } },  // (1)!
  })
  .returning();
```

1. Mesma linguagem de condição do `where` normal — nada de string crua.

No `DO UPDATE` os dois predicados são separados, porque o Postgres os coloca em
lugares distintos da cláusula:

```ts
insert(Outbound)
  .values(message)
  .onConflictDoUpdate(
    ["consumer", "idempotencyKey"],
    { status: "queued" },
    {
      indexWhere: { idempotencyKey: { isNull: false } },  // predicado do índice
      updateWhere: { attempts: { lt: 5 } },               // filtra quem é reescrito
    },
  );
```

Veja a receita [Fila durável com PostgreSQL](queue.md) para o caso de uso
completo.

## Portabilidade

`ON CONFLICT` funciona igual em **SQLite** e **PostgreSQL** — o dialeto gera a
mesma cláusula, predicado incluído. Os valores do `SET` são parametrizados
(ligados após os da linha), nunca interpolados.

!!! warning "MySQL"

    O MySQL usa `ON DUPLICATE KEY UPDATE`, que não tem alvo de conflito. O upsert
    simples funciona; passar `where`/`indexWhere` lança erro explícito em vez de
    emitir SQL que ignora a regra.

## Recap

- `.onConflictDoNothing(target)` → mantém a linha existente.
- `.onConflictDoUpdate(target, set)` → upsert: sobrescreve as colunas dadas.
- `target` = coluna(s) da constraint única/PK.
- `{ where }` / `{ indexWhere }` repetem o predicado de um índice único parcial —
  obrigatório no PostgreSQL para que ele case como conflict target.
- `{ updateWhere }` restringe quais linhas em conflito são de fato reescritas.
- Combina com `.returning()`; portável SQLite ↔ PostgreSQL (MySQL lança erro para
  o predicado).
