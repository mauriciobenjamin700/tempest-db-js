# Escolhendo o driver do SQLite

O tempest-db-js roda SQLite em **dois** drivers. O embutido do Node é o padrão e
não pede instalação nenhuma; o `better-sqlite3` está a uma opção de distância
quando você precisa do que ele expõe a mais.

| Driver | Instalação | Quando usar |
| --- | --- | --- |
| `node:sqlite` (padrão) | nada — vem no Node ≥ 20 | O caso normal |
| `better-sqlite3` | `npm install better-sqlite3` | `pragma()`, extensões carregáveis, ou o driver que o resto do serviço já usa |

## O padrão: nada a fazer

Sem dizer nada, você roda no `node:sqlite`:

```ts
import { Model, column, createSyncEngine, insert, select } from "tempest-db-js";

class Note extends Model {
  static override tablename = "notes";
  id = column.integer().primaryKey();
  title = column.varchar(80).notNull();
}

using engine = createSyncEngine("sqlite:///app.db");
const session = engine.session();

session.execute(insert(Note).values({ id: 1, title: "olá" }));
console.log(session.execute(select(Note)).all());
// [ { id: 1, title: "olá" } ]
```

## Trocando para o `better-sqlite3`

Instale o pacote e diga qual driver quer. Duas formas, mesmo efeito:

=== "Opção do engine"

    ```ts hl_lines="4"
    import { createSyncEngine } from "tempest-db-js";

    using engine = createSyncEngine("sqlite:///app.db", {
      driver: "better-sqlite3",
    });
    ```

=== "Sufixo na URL"

    ```ts hl_lines="3"
    import { createSyncEngine } from "tempest-db-js";

    using engine = createSyncEngine("sqlite+better-sqlite3:///app.db");
    ```

A opção do engine ganha do sufixo quando os dois aparecem — assim uma URL vinda
do ambiente pode ser sobrescrita em teste sem reescrever a string.

O modelo, as queries e as linhas retornadas são **idênticos** nos dois drivers:
mesma coerção de `bigint`, `Date`, `boolean` e JSON, mesmo `RETURNING`, mesmo
`stream()`. Trocar de driver não muda o seu código.

!!! info "Ambos são síncronos"

    Os dois servem tanto o `createSyncEngine` quanto o `createEngine` — no engine
    assíncrono o driver síncrono é embrulhado. SQLite não tem driver async de
    verdade no Node; a diferença é a forma da API que você escreve, não I/O.

## Opções do driver

`driverOptions` vai direto para o construtor do driver escolhido, então cada um
aceita o que a documentação dele documenta:

```ts
using reader = createSyncEngine("sqlite:///app.db", {
  driver: "better-sqlite3",
  driverOptions: { readonly: true },   // (1)!
});
```

1. Opção do `better-sqlite3`. No `node:sqlite` a mesma ideia se escreve
   `{ readOnly: true }` — nomes diferentes, porque é a API do driver, não a nossa.

## Pragmas de conexão

Pragma do SQLite é **por conexão**, não por arquivo — então ele mora no engine, não
numa migração. Só um tem default que muda comportamento:

```ts
using engine = createSyncEngine("sqlite:///app.db", {
  sqlite: {
    foreignKeys: true,      // (1)!
    journalMode: "wal",     // (2)!
    busyTimeoutMs: 5000,    // (3)!
    synchronous: "normal",  // (4)!
  },
});
```

1. **Default `true`.** Ligado por nós, não pelo SQLite.
2. Leitores param de bloquear o escritor. Precisa de arquivo real.
3. Quanto tempo um escritor espera por um lock antes de desistir.
4. Durabilidade × throughput de escrita.

!!! danger "Sem `foreign_keys = ON`, sua FK é decorativa"

    O SQLite nasce com a verificação de foreign key **desligada**, por conexão. Sem
    ligar, um `INSERT` órfão passa e `ON DELETE CASCADE` nunca dispara — a constraint
    está no schema e não faz nada.

    O tempest-db-js liga por padrão, para o mesmo modelo se comportar igual nos três
    bancos. Desligue (`foreignKeys: false`) só para o caso que existe para isso:
    carregar um dump cuja ordem de inserção não respeita o grafo.

!!! info "Pragma recusado é erro, não silêncio"

    O SQLite responde a um pragma que não pode honrar mantendo o valor antigo e **não
    dizendo nada**. Cada pragma é relido depois de escrito, e a divergência vira erro:

    ```ts
    createSyncEngine("sqlite://:memory:", { sqlite: { journalMode: "wal" } });
    // Error: SQLite refused PRAGMA journal_mode = wal for ":memory:" and stayed on
    //        "memory" — an in-memory database cannot use WAL.
    ```

    Banco em memória não faz WAL. Melhor saber na abertura do que descobrir quando a
    latência não melhorou.

!!! warning "Migração que reconstrói tabela religa a FK"

    O SQLite não sabe alterar constraint, então o motor de migração reconstrói a
    tabela (`CREATE new / copy / DROP old`), desligando a verificação de FK em volta da
    cópia e **religando** no fim. Com `foreignKeys: false`, uma migração dessas deixa a
    verificação ligada.

`sqlite` num engine PostgreSQL ou MySQL lança — pragma não existe lá, e ignorar em
silêncio é como uma escolha de durabilidade se perde.

## Nome errado é erro, não silêncio

Um driver que este pacote não tem falha na criação do engine:

```ts
createSyncEngine("sqlite:///app.db", { driver: "sqlite3" });
// Error: Unknown SQLite driver "sqlite3"; supported: "node:sqlite" (built-in, default)
//        and "better-sqlite3".
```

!!! warning "O sufixo da URL é mais tolerante — de propósito"

    `sqlite+aiosqlite:///app.db` e `postgresql+asyncpg://…` **não** dão erro: são
    drivers do ecossistema Python, e uma URL copiada de um serviço Python
    continua conectando (no driver padrão daquele banco). O sufixo que o
    tempest-db-js reconhece seleciona; o que ele não reconhece é ignorado.

    Já a **opção** `driver` é uma escolha explícita sua no código TypeScript —
    por isso ela rejeita o que não existe em vez de ignorar.

## PostgreSQL e MySQL

Cada um roda em um driver só (`postgres` / postgres.js e `mysql2`). Nomear esse
driver é aceito e não muda nada; nomear outro dá erro, pela mesma razão acima:

```ts
createEngine("postgresql://app@localhost/app", { driver: "postgres" }); // ok
createEngine("postgresql://app@localhost/app", { driver: "asyncpg" });
// Error: Unknown postgresql driver "asyncpg"; tempest-db-js runs postgresql on "postgres".
```

## Recapitulando

- SQLite roda no `node:sqlite` por padrão — **zero instalação**.
- `{ driver: "better-sqlite3" }` ou `sqlite+better-sqlite3://` troca o driver;
  a opção ganha do sufixo.
- `driverOptions` é repassado ao construtor do driver escolhido.
- Nome desconhecido na **opção** é erro; sufixo de outro ecossistema na **URL**
  é ignorado, para URL de serviço Python continuar funcionando. 🚀
