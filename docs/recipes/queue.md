# Fila durável com PostgreSQL

Vários workers competindo pelas mesmas linhas, cada um reivindicando um lote sem
bloquear os outros e sem processar a mesma linha duas vezes.

## O problema

O padrão *outbox* / *job queue* sobre Postgres é o mesmo em todo serviço: uma
tabela de mensagens pendentes, N workers, e a regra de ouro de que **uma linha é
processada por exatamente um worker**.

Fazer isso ingenuamente falha de três formas distintas:

1. `SELECT ... WHERE status = 'queued' LIMIT 10` — dois workers leem o mesmo lote
   e a mensagem sai duplicada.
2. Ler `attempts`, somar 1 em JavaScript e escrever de volta — dois workers leem
   `3`, ambos escrevem `4`, e uma tentativa some da contagem.
3. Reinserir a mesma mensagem com a mesma chave de idempotência — duplicata.

As três têm resposta em SQL, e as três são expressáveis pelo builder.

## O modelo

```ts
import { Model, column } from "tempest-db-js";

class Outbound extends Model {
  static tablename = "outbound_messages";
  static naming = "snake_case";

  id = column.uuid().primaryKey();
  consumer = column.text().notNull();
  idempotencyKey = column.text();
  status = column.enum("queued", "sending", "sent", "failed").notNull();
  attempts = column.integer().notNull().default(0);
  nextAttemptAt = column.datetime().notNull();
  updatedAt = column.datetime();
}
```

`static naming = "snake_case"` mantém o schema em `snake_case` (a convenção SQL)
sem contaminar o TypeScript — veja [Nomes de coluna](naming.md).

## 1. Reivindicar um lote — `FOR UPDATE SKIP LOCKED`

```ts
import { createEngine, select, update, sql } from "tempest-db-js";

const engine = createEngine("postgresql://app@localhost/app");

async function claimBatch(size: number): Promise<string[]> {
  return engine.transaction(async (tx) => {
    const rows = await tx
      .execute(
        select(Outbound, ["id"])
          .where({ status: "queued" })
          .orderBy("nextAttemptAt")
          .limit(size)
          .forUpdate({ skipLocked: true }),  // (1)!
      )
      .all();

    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return [];

    await tx
      .execute(
        update(Outbound)
          .set({
            status: "sending",
            attempts: sql.raw("attempts + 1"),  // (2)!
            updatedAt: sql.now(),
          })
          .where({ id: { in: ids } }),
      )
      .rowsAffected();

    return ids;
  });
}
```

1. `SKIP LOCKED` faz o segundo worker **pular** as linhas que o primeiro já
   travou, em vez de esperar por elas. Sem isso, ou os workers serializam (lento)
   ou pegam as mesmas linhas (duplicata).
2. O incremento acontece **no banco**. Nenhum valor de `attempts` viaja até o
   Node e volta, então não há janela para outra transação sobrescrever.

### Numa query só

Com [subquery](#) no `IN`, o `SELECT` e o `UPDATE` colapsam num único statement —
uma roundtrip em vez de duas, e sem materializar os ids no Node:

```ts
const claimed = await session
  .execute(
    update(Outbound)
      .set({
        status: "sending",
        attempts: sql.raw("attempts + 1"),
        updatedAt: sql.now(),
      })
      .where({
        id: {
          in: select(Outbound)
            .where({ status: "queued" })
            .orderBy("nextAttemptAt")
            .limit(10)
            .forUpdate({ skipLocked: true })
            .asSubquery("id"),          // (1)!
        },
      })
      .returning(),
  )
  .all();
```

1. `.asSubquery(coluna)` projeta uma coluna só e marca o `SELECT` como operando de
   `in`/`notIn`. O lock, o `ORDER BY` e o `LIMIT` viajam junto, dentro do
   statement externo.

!!! warning "No MySQL, a subquery não pode ter `LIMIT`"

    O servidor recusa `LIMIT` dentro de `IN (SELECT ...)`. O dialeto lança erro na
    compilação apontando a saída — lá, use a versão de duas etapas acima. Veja
    [MySQL: o que muda](mysql.md).

!!! danger "O lock precisa de uma transação"

    `FOR UPDATE` só vale enquanto a transação estiver aberta. Fora de uma
    `transaction()`, o lock é liberado imediatamente e você não ganhou nada. O
    `SELECT` e o `UPDATE` acima estão de propósito na **mesma** `tx`.

!!! warning "SQLite não tem lock de linha"

    `forUpdate()` lança erro explícito no dialeto SQLite. Isso é deliberado: um
    lock que não existe é pior que um erro, porque o bug só aparece sob
    concorrência em produção. No SQLite, serialize a reivindicação dentro de uma
    transação — a escrita já é exclusiva ali.

`.forUpdate()` aceita também `{ noWait: true }` (falha na hora em vez de esperar)
e `{ of: ["tabela"] }` (restringe o lock a uma tabela do join). O irmão mais fraco
é `.forShare()`.

## 2. Idempotência — índice único **parcial**

A regra: um consumidor que repete o mesmo envio com a mesma `Idempotency-Key` não
pode duplicar a mensagem; linhas **sem** chave nunca são deduplicadas.

```sql
CREATE UNIQUE INDEX outbound_idempotency_unique
    ON outbound_messages (consumer, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
```

O PostgreSQL só reconhece um índice parcial como alvo de `ON CONFLICT` se a query
**repetir o predicado do índice**. É para isso que serve o terceiro argumento:

```ts
import { insert } from "tempest-db-js";

const inserted = await session
  .execute(
    insert(Outbound)
      .values(message)
      .onConflictDoNothing(["consumer", "idempotencyKey"], {
        where: { idempotencyKey: { isNull: false } },  // (1)!
      })
      .returning(),
  )
  .all();

if (inserted.length === 0) {
  // Já existia: repetição idempotente, nada a fazer.
}
```

1. O predicado usa a **mesma linguagem de condição** do `where` normal — nada de
   string crua. Sem ele o Postgres responde
   `there is no unique or exclusion constraint matching the ON CONFLICT specification`.

`onConflictDoUpdate` tem os dois predicados separados, porque no Postgres eles
ficam em lugares diferentes da cláusula:

```ts
insert(Outbound)
  .values(message)
  .onConflictDoUpdate(
    ["consumer", "idempotencyKey"],
    { status: "queued", nextAttemptAt: retryAt },
    {
      indexWhere: { idempotencyKey: { isNull: false } },  // predicado do índice
      updateWhere: { attempts: { lt: 5 } },               // só reescreve quem ainda pode tentar
    },
  );
```

!!! info "Portabilidade"

    O predicado do conflict target funciona em **PostgreSQL** e **SQLite**. O
    MySQL usa `ON DUPLICATE KEY UPDATE`, que não tem alvo de conflito — o dialeto
    lança erro explícito em vez de emitir SQL que ignora a regra.

## 3. Contadores sem race — expressões no `set`

`sql.raw()` escreve uma expressão SQL literal; `` sql.expr`` `` escreve uma
expressão **parametrizada**, com cada `${...}` virando um parâmetro ligado:

```ts
update(Outbound)
  .set({
    attempts: sql.raw("attempts + 1"),                 // SQL verbatim
    nextAttemptAt: sql.expr`now() + ${backoff} * interval '1 second'`,
    updatedAt: sql.now(),                              // token portável
  })
  .where({ id });
```

!!! danger "Objeto solto no `set` agora falha alto"

    Antes da v0.5.0, `set({ attempts: { raw: "attempts + 1" } })` era **ligado
    como parâmetro** e gravava lixo na coluna, sem erro. Hoje qualquer valor que
    não seja um escalar nem uma expressão marcada levanta `ValidationError` na
    hora de montar a query. Se você quer uma expressão, use `sql.raw()` /
    `` sql.expr`` ``.

## O worker completo

```ts
async function drain(): Promise<void> {
  const ids = await claimBatch(10);
  for (const id of ids) {
    try {
      await deliver(id);
      await session
        .execute(
          update(Outbound)
            .set({ status: "sent", updatedAt: sql.now() })
            .where({ id }),
        )
        .rowsAffected();
    } catch {
      await session
        .execute(
          update(Outbound)
            .set({
              status: "queued",
              nextAttemptAt: sql.expr`now() + ${backoffSeconds} * interval '1 second'`,
            })
            .where({ id }),
        )
        .rowsAffected();
    }
  }
}
```

## Recap

- `.forUpdate({ skipLocked: true })` dentro de uma `transaction()` → cada worker
  leva um lote disjunto. `noWait` e `of` também estão disponíveis; `forShare()` é
  a versão de leitura.
- SQLite lança erro em vez de fingir que travou.
- `onConflictDoNothing(target, { where })` repete o predicado do índice parcial,
  que é o que faz o Postgres aceitá-lo como conflict target.
- `sql.raw()` / `` sql.expr`` `` / `sql.now()` no `set` mantêm o incremento no
  banco, sem read-modify-write.
- Objeto não marcado no `set`/`values` é `ValidationError`, não corrupção
  silenciosa.
- `.asSubquery(coluna)` no `in` fecha a reivindicação numa query só (menos no
  MySQL, que recusa `LIMIT` em subquery).
