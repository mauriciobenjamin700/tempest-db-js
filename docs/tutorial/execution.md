# Executando queries

Até aqui montamos queries como **AST tipada**, sem tocar em banco. Agora vamos
**executar** de verdade: criar um engine a partir de uma URL, abrir uma sessão e
rodar as queries.

!!! info "Async por padrão, sync opcional"

    O Querium é **async-first**: `createEngine` devolve um engine assíncrono, que
    funciona pra SQLite e PostgreSQL. Pra SQLite há também `createSyncEngine`
    (síncrono) — ótimo pra scripts, seeds e testes. PostgreSQL é async-only (não
    existe driver sync sério no Node).

## Passo 1 — Crie o engine a partir da URL

O banco é identificado pela **URL** — trocar de banco é trocar a string:

```ts
import { createEngine, createSyncEngine } from "querium";

const engine = createEngine("postgresql://app:app@localhost/app"); // async
const sqlite = createEngine("sqlite:///app.db");                    // async, SQLite
const sync   = createSyncEngine("sqlite://:memory:");               // sync, SQLite
```

!!! tip "Drivers"

    SQLite usa o `node:sqlite` embutido do Node por padrão (zero instalação).
    PostgreSQL usa `postgres.js` (instale `postgres`). São peer deps opcionais —
    instale só o que usar.

## Passo 2 — Abra uma sessão e execute

`session.execute(query)` compila a query pro dialeto certo, roda, e **coage** as
linhas de volta pros tipos nativos (bigint, `Date`, boolean, JSON):

=== "Async (padrão)"

    ```ts
    const session = engine.session();

    const adults = await session.execute(
      select(User).where({ age: { gte: 18 } }),
    ).all(); // UserRow[]

    const user = await session.execute(
      select(User).where({ id: 1 }),
    ).first(); // UserRow | null

    await session.close();
    ```

=== "Sync (SQLite)"

    ```ts
    const session = sync.session();

    const adults = session.execute(
      select(User).where({ age: { gte: 18 } }),
    ).all(); // UserRow[] — sem await

    session.close();
    ```

### Terminais do resultado

| Terminal | Retorna | Observação |
| --- | --- | --- |
| `.all()` | `Row[]` | todas as linhas |
| `.first()` | `Row \| null` | a primeira, ou `null` |
| `.one()` | `Row` | erro (`NoResultError`) se ≠ 1 |
| `.oneOrNull()` | `Row \| null` | erro se > 1 |
| `.scalar()` | valor da 1ª coluna `\| null` | útil com projeção de 1 coluna |
| `.scalars()` | valores da 1ª coluna `[]` | — |
| `.rowsAffected()` | `number` | pra INSERT/UPDATE/DELETE sem `returning` |

O tipo já vem do builder — `session.execute(select(User)).all()` é `UserRow[]` sem
anotação.

## Passo 3 — O guard de mutação na execução

Lembra do guard tipado do `update`/`del`? Ele vale **na borda de execução**:
`execute` só aceita um `update`/`del` já guardado (com `.where()` ou
`.unguarded()`):

```ts
session.execute(update(User).set({ age: 31 }).where({ id: 1 })); // ✅
// session.execute(update(User).set({ age: 0 }));  // ❌ erro de compilação
```

## Passo 4 — Transações

O caminho recomendado: bloco transacional que faz **commit no sucesso** e
**rollback em exceção**:

```ts
await engine.transaction(async (tx) => {
  await tx.execute(insert(Order).values({ userId: 1, amount: 100, status: "paid" }));
  await tx.execute(update(User).set({ orders: 1 }).where({ id: 1 }));
  // commit automático; se algo lançar → rollback automático
});
```

Savepoints (transação aninhada) com `beginNested`:

```ts
engine.transaction((tx) => {
  tx.execute(insert(User).values(a));
  try {
    tx.beginNested((sp) => {
      sp.execute(insert(User).values(b)); // se falhar, só esse savepoint reverte
    });
  } catch {
    // a transação externa segue viva
  }
});
```

!!! check "Tudo testado com banco real"

    A execução SQLite do Querium é exercitada em testes contra um banco real
    (`node:sqlite`), incluindo coerção de tipos, `RETURNING`, e rollback de
    transação. Não é mock.

## Passo 5 — Streaming de resultados grandes

Pra não materializar tudo em memória, `session.stream(query)` itera linha a linha —
sync (SQLite) ou async (`for await`):

```ts
// sync
for (const user of sync.session().stream(select(User))) {
  process(user);
}

// async
for await (const user of engine.session().stream(select(User))) {
  await process(user);
}
```

!!! tip "Pool (PostgreSQL)"

    `createEngine(url, { pool: { size: 10, idleTimeoutMs: 30000 } })` ajusta o pool
    do `postgres.js`. No SQLite o pool é ignorado (conexão única).

## Recap

- `createEngine(url)` (async) / `createSyncEngine(url)` (SQLite sync) — banco pela URL.
- `session.execute(query)` infere o retorno e coage tipos.
- Terminais: `.all/.first/.one/.oneOrNull/.scalar/.scalars/.rowsAffected`.
- Guard de mutação aplicado em `execute`.
- `engine.transaction(fn)` (commit/rollback automático) + `beginNested` (savepoints).

Pra consultar várias tabelas de uma vez, vamos aos **[Joins](joins.md)**. 👉
