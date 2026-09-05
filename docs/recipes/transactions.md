# Transações e savepoints

**Problema:** algumas operações só fazem sentido **juntas** — debitar de uma conta e
creditar em outra, criar um pedido e baixar o estoque. Se a segunda falha, a primeira
**não pode** ficar de pé.

**Solução:** `engine.transaction(fn)` roda seu bloco numa transação: **commit** se tudo
der certo, **rollback** automático se qualquer coisa lançar. Pra rollback parcial, há
`beginNested` (savepoints).

## A teoria em uma frase

`transaction(fn)` faz `BEGIN`, roda `fn`, e então `COMMIT` — mas se `fn` lança, faz
`ROLLBACK` e re-lança o erro. Você nunca precisa lembrar de fechar a transação na mão.

## Tudo ou nada

```ts
import { createEngine, insert, update } from "tempest-db-js";

const engine = createEngine("sqlite:///bank.db");

await engine.transaction(async (tx) => {
  await tx.execute(update(Account).set({ balance: 90 }).where({ id: 1 }));
  await tx.execute(update(Account).set({ balance: 110 }).where({ id: 2 }));
  // chegou aqui sem lançar → COMMIT automático
});
```

Se a segunda linha lançar (saldo insuficiente, violação de constraint, etc.), a
**primeira é desfeita** — as duas contas voltam ao estado anterior.

!!! danger "Não capture o erro silenciosamente dentro do bloco"

    O rollback é disparado pela **exceção propagando pra fora** de `fn`. Se você
    `try/catch` tudo lá dentro e engole o erro, o `transaction` acha que deu certo e
    faz **commit**. Deixe o erro subir (ou re-lance) quando quiser abortar.

## Savepoints: rollback parcial

`beginNested` cria um **savepoint** — uma sub-transação que pode reverter sozinha sem
derrubar a transação externa. Útil pra "tente isso; se falhar, siga sem ele":

```ts
await engine.transaction(async (tx) => {
  await tx.execute(insert(Order).values({ userId: 1, total: "100.00" }));

  try {
    await tx.beginNested(async (sp) => {
      await sp.execute(insert(Coupon).values({ orderId: 1, code: "INVALIDO" }));
      // se isso violar uma constraint, só ESTE savepoint reverte
    });
  } catch {
    // o cupom falhou, mas o pedido continua de pé — seguimos sem desconto
  }

  await tx.execute(update(Order).set({ status: "confirmado" }).where({ id: 1 }));
  // COMMIT: pedido criado + confirmado; cupom descartado
});
```

!!! info "Sync também tem transação"

    Em SQLite síncrono (`createSyncEngine`), `engine.transaction((tx) => { ... })`
    funciona igual — sem `await`. Ótimo pra seeds e scripts.

    ```ts
    sync.transaction((tx) => {
      tx.execute(insert(User).values({ name: "seed", age: 1, nickname: null }));
    });
    ```

## Blocos aninhados: um COMMIT só

`transaction()` é **re-entrante**. Um bloco aberto dentro de outro, na mesma sessão,
adere ao de fora: um `BEGIN`, um `COMMIT`, e a falha interna derruba tudo.

```ts
const session = engine.session();
const orders = new BaseRepository(Order, session);
const items = new BaseRepository(Item, session);

await session.transaction(async () => {
  await orders.create({ id: 1, total: 10 });   // sem COMMIT aqui
  await items.createMany(lines);               // nem aqui
});                                            // um COMMIT no fim
```

Isso é o que faz um service que orquestra vários repositories funcionar: todos seguram
a **mesma sessão**, então todos enxergam o mesmo bloco aberto. Sem re-entrância, o
segundo `transaction()` emitiria um `BEGIN` dentro de outro.

```ts
session.transactionDepth;   // 0 fora, 1 no bloco, 2 no aninhado
session.inTransaction;      // boolean
```

!!! danger "Aninhado não é recuperável — savepoint é"

    Falha em bloco aninhado **derruba o bloco inteiro**, inclusive o trabalho de fora.
    Para recuperar de uma falha interna sem descartar o resto, use `beginNested`, que é
    `SAVEPOINT` de verdade:

    ```ts
    await session.transaction(async (tx) => {
      await orders.create(order);                       // fica
      await tx.beginNested(async (sp) => {
        await risky(sp);                                // se falhar, só isto volta
      }).catch(logAndContinue);
      await audit.create(entry);                        // continua rodando
    });
    ```

    `beginNested` precisa de um bloco aberto — o PostgreSQL recusa savepoint fora de
    transação.

## Recap

- `engine.transaction(fn)` → `COMMIT` no sucesso, `ROLLBACK` se `fn` lançar.
- Deixe o erro **propagar** pra abortar — engolir o erro causa commit indevido.
- `tx.beginNested(fn)` → savepoint; reverte só a sub-transação.
- Vale pra async (`createEngine`) e sync (`createSyncEngine`).
