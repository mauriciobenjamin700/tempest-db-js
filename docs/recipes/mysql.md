# MySQL: o que muda

O terceiro banco do escopo. A maior parte do builder funciona igual — este guia é
sobre as diferenças que aparecem.

## Conectando

```ts
import { createEngine } from "tempest-db-js";

const engine = createEngine("mysql://app:secret@localhost:3306/app");
```

`mysql2` é peer dependency **opcional**, carregada preguiçosamente na primeira
query:

```bash
npm install mysql2
```

`mariadb://` também é reconhecido e usa o mesmo dialeto.

## `RETURNING` — o round-trip

O MySQL não tem `RETURNING`. Ainda assim, `.returning()` funciona num **insert de
uma linha**: a sessão insere e lê a linha de volta pela chave, na mesma conexão.

```ts
const created = await session
  .execute(insert(Task).values({ ownerName: "Ana", title: "ship" }).returning())
  .one();

created.id;  // preenchido pelo AUTO_INCREMENT
```

É isso que faz `BaseRepository.create()` e `activeRecord.save()` funcionarem no
MySQL.

Como a chave é escolhida:

- **PK fornecida** (uuid, texto) → lê de volta por esse valor.
- **PK auto-increment** → lê de volta por `LAST_INSERT_ID()`.

!!! danger "`LAST_INSERT_ID()` é por conexão"

    Fora de uma transação a sessão **reserva** uma conexão do pool para o par de
    statements; dentro de `transaction()` ela já está fixada numa. De qualquer
    forma o insert e a leitura caem na mesma conexão — e a leitura faz rollback
    junto com a transação.

!!! warning "Insert de N linhas com `.returning()` é erro"

    `LAST_INSERT_ID()` identifica só a **primeira** linha de um insert múltiplo, e
    as demais são consecutivas apenas sob certos `innodb_autoinc_lock_mode`. Em
    vez de devolver linhas possivelmente erradas, a sessão lança:

    ```
    mysql has no RETURNING, and reading back a multi-row insert is not reliable —
    insert one row at a time, or drop .returning().
    ```

`UPDATE`/`DELETE` com `.returning()` não têm equivalente barato e continuam
lançando — rode um `SELECT` você mesmo.

## O que o MySQL não faz

Cada item abaixo lança **erro explícito**, nunca degrada em silêncio:

| Recurso | Situação no MySQL |
| --- | --- |
| `LIMIT`/`OFFSET` dentro de `IN (SELECT ...)` | Não suportado pelo servidor. Selecione os ids antes, ou envolva numa derived table. |
| Predicado no conflict target ([upsert](upsert.md)) | `ON DUPLICATE KEY UPDATE` não tem alvo de conflito. |
| [`column.array()`](arrays.md) | Sem tipo array nativo. |
| `check` de drift no CLI | Introspecção via `information_schema` ainda não implementada. |

## O que funciona igual

- **`FOR UPDATE SKIP LOCKED`** (MySQL 8.0+) — o padrão de
  [fila durável](queue.md) roda igual.
- **Expressões na escrita** — `sql.raw("attempts + 1")`, `` sql.expr`` ``,
  `sql.now()`.
- **`ieq`** — `lower(col) = lower(?)`.
- **Subquery em `IN`**, desde que sem `LIMIT`.
- **`HAVING`** e `ORDER BY` por alias de agregação.
- **Upsert** simples via `ON DUPLICATE KEY UPDATE`.
- **[Nomes de coluna](naming.md)** e naming strategy.

## Diferenças de DDL

O renderer emite `INT`/`BIGINT`, `VARCHAR(n)`, `DATETIME`, `TINYINT(1)` para
boolean, `JSON`, `CHAR(36)` para uuid, `ENUM` nativo, `AUTO_INCREMENT` para a PK
inteira solitária, `RENAME TABLE` e `MODIFY COLUMN`. Identificadores usam crase.

## Recap

- `mysql://` + `npm install mysql2`.
- `.returning()` funciona em insert de **uma** linha, via read-back na mesma
  conexão; N linhas e UPDATE/DELETE lançam.
- Subquery com `LIMIT`, predicado de `ON CONFLICT` e `column.array()` lançam erro
  explícito.
- Lock de linha, expressões, `ieq`, `HAVING` e upsert simples funcionam normal.
