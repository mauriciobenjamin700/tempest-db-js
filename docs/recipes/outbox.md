# Outbox transacional

Um handler que **grava uma linha** e **publica um evento** não consegue fazer as duas
coisas com segurança como operações independentes:

- morreu depois do commit e antes do publish → o evento se perde;
- morreu depois do publish e antes do commit → evento fantasma apontando para uma linha
  que nunca existiu.

O outbox resolve escrevendo a linha de negócio **e** a linha de evento na **mesma
transação**. Ou as duas commitam, ou nenhuma. Um relay separado lê o que está pendente e
publica; o broker pode ficar minutos fora do ar que os eventos esperam na tabela.

## O model

```ts
import { outboxModel } from "tempest-db-js";

class OutboxEvent extends outboxModel("outbox") {}
```

Colunas: `id`, `topic`, `payload`, `status` (`pending`/`sending`/`sent`/`failed`),
`attempts`, `availableAt`, `createdAt`, `sentAt`, `lastError`.

## Escrevendo (o lado do handler)

```ts
await session.transaction(async () => {
  const order = await orders.create(data);
  await outbox.publish({ topic: "order.created", payload: { id: order.id } });
});
```

!!! info "A atomicidade vem do `transaction()`, não de um mecanismo novo"

    `publish()` **não** abre transação própria de propósito: os dois repositories usam a
    mesma session, e `transaction()` é re-entrante. Um método `saveWithOutbox` seria um
    segundo jeito de fazer a mesma coisa.

## Publicando (o lado do relay)

```ts
const batch = await session.transaction(async (tx) =>
  new OutboxRepository(OutboxEvent, tx).claim(50),
);

for (const event of batch) {
  try {
    await broker.publish(event.topic, event.payload);
    await outbox.markSent([event.id]);
  } catch (error) {
    await outbox.markFailed(event.id, error, { retryInMs: 30_000 });
  }
}
```

`claim` usa `FOR UPDATE SKIP LOCKED` sobre uma subquery: dois relays rodando ao mesmo
tempo pegam lotes **disjuntos** em vez de brigar pelas mesmas linhas. O contador
`attempts` é incrementado **no claim**, então a linha carrega o próprio histórico — é o
que uma política de dead-letter lê.

!!! warning "`claim` não existe no SQLite"

    SQLite não tem lock de linha, então `forUpdate` lança lá — a política do projeto é
    erro explícito, não fallback silencioso. Num relay de processo único, use `pending()`
    e um `update` seu.

!!! danger "Publicar é *at least once*"

    O relay pode publicar e morrer antes do `markSent`. O evento sai de novo na próxima
    rodada. Consumidor precisa ser **idempotente** — isso é propriedade do padrão, não
    limitação desta implementação.

!!! tip "Backoff e dead letter"

    `markFailed(id, error, { retryInMs })` devolve a linha para `pending` só depois do
    prazo; `{ permanent: true }` marca `failed` e para de tentar. Com `attempts` na mão,
    um `WHERE attempts >= 10` é a sua fila de dead letter.

## Recapitulando

- `outboxModel(tabela)` dá o schema; `OutboxRepository` dá o relay.
- Escreva evento e linha de negócio no mesmo `transaction()`.
- `claim` → publique → `markSent`, ou `markFailed` com backoff.
- Dois relays concorrentes pegam lotes disjuntos (PostgreSQL). 🚀
