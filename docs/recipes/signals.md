# Signals do repositório

Reagir a persistência — invalidar cache, enfileirar evento, sincronizar índice de
busca, escrever auditoria — sem envolver **todo** call site à mão. O call site que
alguém esquecer é o bug.

```ts
import { onSignal } from "tempest-db-js";

onSignal(User, "postSave", async ({ row, session }) => {
  await cache.del(`user:${row.id}`);
});
```

## Os quatro pontos

| Signal | Quando | O que `row` traz |
| --- | --- | --- |
| `preSave` | antes do INSERT/UPDATE | o que você passou (insert) ou a linha já com o patch (update) |
| `postSave` | depois | a linha **armazenada** — id gerado incluído |
| `preDelete` | antes do DELETE | a linha como estava; é a última chance de vê-la |
| `postDelete` | depois | a mesma imagem de antes |

Disparam em `create`, `createMany`, `update` e `delete` do `BaseRepository` — **por
linha**, mesmo num lote.

## Vetar uma escrita

```ts
onSignal(Order, "preSave", ({ row }) => {
  if (row.total < 0) throw new ValidationError("total negativo");
});
```

Handler que lança em `preSave`/`preDelete` **impede a escrita**: o erro sobe para quem
chamou. Não é sugestão — um veto que pudesse ser engolido não seria veto.

## O handler roda dentro da sua transação

O payload traz a **mesma** `session` da escrita. Handler que escreve comita junto:

```ts
onSignal(Order, "postSave", async ({ row, session }) => {
  await new BaseRepository(OutboxEvent, session).create({ topic: "order.created", ... });
});

await session.transaction(async () => {
  await orders.create(order);   // linha + evento, ou nenhum dos dois
});
```

!!! info "Sem handler, sem custo"

    `update`/`delete` recebem **filtro**, não linha — para entregar a linha ao handler é
    preciso lê-la antes. Esse `SELECT` extra só acontece quando há handler registrado
    (`hasHandlers`), então quem não usa signals não paga nada.

!!! warning "`activeRecord` não dispara"

    Os signals estão no caminho do `BaseRepository`. O `activeRecord` escreve pelos
    builders direto e **não** dispara — se você mistura os dois, faça a escrita
    observável passar pelo repository.

!!! tip "Limpe entre testes"

    Handler registrado é global e vive até o processo morrer. `clearSignals()` (ou
    `clearSignals(Model)`) num `afterEach` evita um teste enxergar o handler do outro.

## Recapitulando

- `onSignal(Model, signal, handler)` devolve a função que desregistra.
- `preSave`/`preDelete` que lançam **vetam** a escrita.
- O handler recebe a session da escrita, então participa da transação.
- `hasHandlers` é o que mantém o custo em zero para quem não usa. 🚀
