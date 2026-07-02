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

## Portabilidade

`ON CONFLICT` funciona igual em **SQLite** e **PostgreSQL** — o dialeto gera a
mesma cláusula. Os valores do `SET` são parametrizados (ligados após os da linha),
nunca interpolados.

## Recap

- `.onConflictDoNothing(target)` → mantém a linha existente.
- `.onConflictDoUpdate(target, set)` → upsert: sobrescreve as colunas dadas.
- `target` = coluna(s) da constraint única/PK.
- Combina com `.returning()`; portável SQLite ↔ PostgreSQL.
