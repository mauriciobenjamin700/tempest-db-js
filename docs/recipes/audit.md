# Trilha de auditoria

`withTimestamps` guarda **quando** a linha mudou e `withAudit` guarda **quem** mexeu por
último. Nenhum dos dois guarda o **histórico**: uma entrada por create, update e delete,
com ator, ação e diff antes/depois.

```ts
import { auditLogModel, enableAudit } from "tempest-db-js";

class AuditLog extends auditLogModel("audit_log") {}

enableAudit(Order, {
  log: AuditLog,
  actor: () => currentUser()?.id ?? null,   // (1)!
  exclude: ["passwordHash"],                // (2)!
});
```

1. Chamado **no momento da escrita**, então pode ler o contexto da request.
2. Coluna que não vale registrar — hash, blob grande.

## O que fica gravado

| Coluna | Conteúdo |
| --- | --- |
| `tableName` / `rowKey` | qual tabela e qual chave primária (objeto, chave composta inteira) |
| `action` | `insert` · `update` · `delete` |
| `actor` | o que o resolver devolveu, ou `null` |
| `changes` | `{ coluna: [antes, depois] }` — só o que mudou no update; a linha toda no insert/delete |
| `at` | quando |

## Escrito na mesma transação

`enableAudit` liga os [signals do repositório](signals.md), então a entrada é escrita na
**mesma session** — e portanto na mesma transação — da mudança:

```ts
await session.transaction(async () => {
  await orders.create(order);   // linha + entrada de auditoria
  throw new Error("regra de negócio");
});
// nenhuma das duas sobrevive
```

!!! danger "Auditoria de mudança que sofreu rollback seria mentira"

    É o motivo de a entrada não ser escrita "depois", em outra transação: uma trilha que
    registra uma mudança que nunca commitou é pior que não ter trilha.

!!! info "Update sem mudança real não gera entrada"

    `update({ id }, { total: 10 })` num pedido que já vale 10 não escreve nada — o diff
    sai vazio. Trilha cheia de entrada sem delta é ruído que esconde o que importa.

!!! warning "O `before` custa um SELECT"

    Para ter o lado "antes" do diff, o handler de `preSave` lê a linha atual. É o mesmo
    custo que qualquer trilha com diff paga; se ele pesa numa tabela quente, audite só os
    modelos que precisam.

## Recapitulando

- `auditLogModel(tabela)` dá o schema; `enableAudit(Model, ...)` liga e devolve o
  desligador.
- Diff só do que mudou, com o ator resolvido na hora da escrita.
- Mesma transação da mudança — rollback leva a entrada junto. 🚀
