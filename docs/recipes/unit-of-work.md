# Unit of work e identity map (opt-in)

O padrão do pacote continua o mesmo: **linha é objeto simples**, e a escrita acontece
quando você pede. Isto aqui é o outro modelo, para o código que prefere: carregue,
mutacione, e deixe **um** `flush()` descobrir os statements.

```ts
const uow = session.unitOfWork();

const ana = await uow.get(User, 1);
const mesma = await uow.get(User, 1);   // (1)!

ana.visits += 1;
uow.add(Post, { id: 10, userId: 1, title: "novo" });

await uow.flush();                       // (2)!
```

1. **A mesma instância** — e sem segunda query.
2. Uma transação: inserts, depois updates, depois deletes.

## O que ele resolve

| | Sem unit of work | Com |
| --- | --- | --- |
| Carregar a mesma linha duas vezes | dois objetos que podem divergir | **um** objeto |
| Dez mutações | dez round trips | os statements que as mudanças exigem, num commit |
| Update | você escolhe as colunas | só o que mudou de fato |

## `Tracked<Row>` no tipo

`get()` devolve `Tracked<Row>` — a mesma forma da linha, com uma marca. Uma função que
exige `Tracked<Row>` não aceita um objeto solto que ninguém vai dar flush:

```ts
function agendar(row: Tracked<UserRow>): void { /* ... */ }
agendar(await uow.get(User, 1));      // ok
agendar(await users.getById(1));      // ❌ erro de compilação
```

!!! info "Diff por valor, não por referência"

    `Date` e `Uint8Array` são comparados por **conteúdo**: reatribuir a mesma data não
    conta como mudança. Comparar por referência faria toda linha com `Date` ser reescrita
    a cada flush.

!!! warning "A ordem é inserts → updates → deletes, não uma ordenação topológica"

    É a ordem que mantém uma FK satisfeita quando um pai novo e seus filhos vão juntos.
    **Não** é um sort por dependência: um grafo que precisa disso deve ser dado em
    estágios — `flush()` no meio.

!!! danger "Falha no meio derruba o flush inteiro"

    Tudo roda numa transação. Um statement que falha faz rollback do conjunto, e o estado
    rastreado fica **intacto** — dá para corrigir e chamar `flush()` de novo.

!!! tip "Escopo explícito"

    Um `unitOfWork()` por request, por job, por caso de uso. Nada global; nada
    compartilhado entre requests. `clear()` esquece tudo sem escrever.

## Recapitulando

- `session.unitOfWork()` → identity map + change log.
- `get`/`track`/`add`/`remove`, e um `flush()` numa transação.
- Update escreve **só** o que mudou; nada mudou ⇒ nenhum statement.
- O caminho padrão de objeto simples não muda em nada. 🚀
