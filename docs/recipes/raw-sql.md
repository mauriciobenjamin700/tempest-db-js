# SQL cru em runtime (`session.raw`)

A saída de emergência para a query que o builder ainda não expressa — sem
precisar manter um segundo stack de banco em paralelo.

## O problema

Um query builder nunca vai cobrir 100% do SQL. Isso é aceitável — desde que exista
uma saída. Sem ela, **uma única query não suportada obriga o projeto inteiro a
carregar um segundo cliente de banco** (`pg` cru ao lado do ORM), com duas pools,
dois timeouts e duas convenções de mapeamento de linha. O custo não é proporcional
ao tamanho do buraco.

As migrações já tinham essa saída (`Op.execute`). Em runtime, ela é
`session.raw()`.

## Uso

```ts
import { createEngine } from "tempest-db-js";

const engine = createEngine("postgresql://app@localhost/app");
const session = engine.session();

const rows = await session
  .raw<{ waiting: number; oldestSeconds: number }>(
    `SELECT count(*)::int                                      AS "waiting",
            EXTRACT(EPOCH FROM (now() - MIN(created_at)))::int AS "oldestSeconds"
       FROM outbound_messages
      WHERE status = $1`,
    ["queued"],
  )
  .all();
```

O retorno é o mesmo `AsyncResult` do `execute`, então `.all()`, `.first()`,
`.one()`, `.oneOrNull()`, `.scalar()`, `.scalars()` e `.rowsAffected()` estão
todos disponíveis. Na `SyncSession` (SQLite) o método é idêntico, só que
síncrono.

## Sempre parametrizado

A assinatura é `(sql, params)` — nunca interpolação:

```ts
// ✅ Correto — o valor vira parâmetro ligado
session.raw("DELETE FROM sessions WHERE user_id = $1", [userId]);

// ❌ Errado — porta aberta para SQL injection
session.raw(`DELETE FROM sessions WHERE user_id = '${userId}'`);
```

!!! danger "A string SQL é interpolada literalmente"

    `raw` não valida o texto do statement — não tem como. Tudo que vier de fora
    do seu código vai em `params`, sempre. Passar um `params` que não seja array
    levanta `TypeError` na hora, justamente para pegar a chamada que "esqueceu"
    os parâmetros.

## Integrado ao resto

`raw` não é um bypass do runtime — passa exatamente pelo mesmo caminho de um
statement compilado:

- **Logging.** Aparece no `onQuery` como qualquer outra query.
- **Erros.** Falha vira `QueryExecutionError`, com o SQL e os params anexados.
- **Transações.** Dentro de `transaction()` roda na conexão reservada, e faz
  rollback junto.

```ts
await engine.transaction(async (tx) => {
  await tx.raw("SET LOCAL statement_timeout = '5s'");
  await tx.execute(insert(Event).values(payload));
});
```

## Coerção opcional pelo modelo

Sem `as`, as linhas voltam como o driver as entregou. Passando o modelo, elas
passam pela mesma coerção de tipos do `execute` — `Date`, `bigint`,
`Uint8Array`, JSON e o mapeamento de nome de coluna:

```ts
const claimed = await session
  .raw<OutboundRow>(
    `UPDATE outbound_messages SET status = 'sending'
      WHERE id = ANY($1) RETURNING *`,
    [ids],
    { as: Outbound },
  )
  .all();

claimed[0].createdAt instanceof Date;  // true
```

## Quando *não* usar

`raw` é a exceção, não o padrão. Antes de alcançá-lo, confira se o builder já
resolve:

| Você precisa de | Use |
| --- | --- |
| `FOR UPDATE SKIP LOCKED` | [`.forUpdate({ skipLocked: true })`](queue.md) |
| `attempts = attempts + 1` | [`sql.raw()` no `set`](queue.md) |
| `ON CONFLICT ... WHERE` | [`onConflictDoNothing(target, { where })`](upsert.md) |
| `lower(col) = lower($1)` | [`{ ieq: valor }`](case-insensitive.md) |
| `text[]`, `@>`, `&&` | [`column.array()`](arrays.md) |

!!! note "Por que o schema é diferente"

    Migração reversível e autogerada é o núcleo do projeto, e ali um `.sql`
    escrito à mão custa caro: o schema é finito e você o controla. O espaço de
    *queries* é o oposto — infinito e dirigido pelo produto. Por isso o schema
    fica tipado e a query ganha escape hatch.

## Recap

- `session.raw(sql, params, options?)` roda um statement cru, sempre
  parametrizado.
- Retorna o mesmo result view do `execute`.
- Participa de `onQuery`, `QueryExecutionError` e `transaction()`.
- `{ as: Model }` coage as linhas pelos tipos do modelo.
- Prefira o builder quando ele já expressa a query.
