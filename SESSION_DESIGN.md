# Querium — Design da Execução: Engine, Session, Pool, Transações (Fase 4)

> Como o Querium executa queries contra o banco. Inspiração: o modelo
> **Engine / Session / Connection Pool** do SQLAlchemy 2.0. **Async por padrão**,
> com modo **sync opcional**.

## Decisões travadas

| Decisão | Escolha | Por quê |
|---|---|---|
| Modelo de concorrência | **Async por padrão**; **sync opcional** | I/O de banco é async-first; sync pra scripts/CLI/SQLite embarcado. |
| API async vs sync | **Funções/tipos separados** (`createEngine` async, `createSyncEngine` sync) | Tipos honestos: async retorna `Promise`, sync não. Uma flag booleana não muda tipo de retorno. |
| Identificação do banco | **Via URL** (`parseDatabaseUrl`) | Trocar de banco = trocar a string. Já implementado em `src/url.ts`. |
| Pool de conexões | **QueuePool** (Postgres); **conexão única** (SQLite memória) | Espelha SQLAlchemy; SQLite arquivo/memória não paraleliza escrita. |
| Transação | **Unit of work**: `session.begin()` / `engine.transaction(fn)` com commit/rollback automático | Bloco transacional seguro, rollback em exceção. |
| Savepoints | `session.beginNested()` | Aninhamento via SAVEPOINT, igual SQLAlchemy. |

## Suporte sync por dialeto (constraint honesta)

| Dialeto | Async | Sync |
|---|---|---|
| SQLite | ✅ (wrap de `better-sqlite3`, que é sync por baixo) | ✅ (`better-sqlite3` nativo, **rápido**) |
| PostgreSQL | ✅ (`postgres.js`) | ⚠️ **não** — não existe driver pg sync sério no Node |

!!! nota
    Sync é first-class pra SQLite (CLI, scripts, testes, apps embarcados). Postgres
    é async-only — não vamos fingir um driver sync que bloqueia a thread com
    polling. `createSyncEngine` com URL Postgres **lança erro claro** apontando o
    `createEngine` async.

---

## 1. Engine — criado a partir da URL

```ts
import { createEngine, createSyncEngine } from "querium";

// Async (padrão) — funciona pra SQLite e PostgreSQL
const engine = createEngine("postgresql://app:app@localhost/app");
const sqlite = createEngine("sqlite:///app.db");

// Sync (opcional) — SQLite only
const syncEngine = createSyncEngine("sqlite:///app.db");
```

O engine:

- detecta dialeto + driver via `parseDatabaseUrl` (já pronto);
- segura o **pool de conexões**;
- é um singleton de aplicação (criado uma vez, compartilhado);
- expõe `engine.session()`, `engine.transaction(fn)`, `engine.dispose()`.

```ts
interface EngineOptions {
  readonly pool?: PoolOptions;
  readonly echo?: boolean;          // loga o SQL emitido (debug)
  readonly driver?: string;         // sobrescreve o driver detectado da URL
}

interface PoolOptions {
  readonly size?: number;           // default 5
  readonly maxOverflow?: number;    // conexões extras sob pico, default 10
  readonly idleTimeoutMs?: number;  // fecha ocioso, default 30s
  readonly acquireTimeoutMs?: number; // espera por conexão, default 30s
  readonly prePing?: boolean;       // valida conexão antes de usar, default true
  readonly recycleMs?: number;      // recicla conexão velha (evita timeout do servidor)
}
```

SQLite em memória usa **uma conexão estática** (pool de 1) — o pool é ignorado.
SQLite em arquivo: pool pequeno; escrita serializada (limitação do SQLite, não
nossa).

---

## 2. Session — unidade de trabalho

A `Session` (async) / `SyncSession` (sync) é a fronteira de transação e o ponto de
execução de queries. Espelha a `AsyncSession` do SQLAlchemy.

```ts
const session = engine.session();
try {
  const adults = await session.execute(select(User).where({ age: { gt: 18 } })).all();
  await session.execute(insert(User).values({ name: "Ben", age: 30 }));
  await session.commit();
} catch (e) {
  await session.rollback();
  throw e;
} finally {
  await session.close();
}
```

### Resultado tipado (terminais)

`session.execute(query)` devolve um **Result** que carrega o tipo do builder
(provado nas Fases 1-2). Os terminais:

| Terminal | Retorno | Erro |
|---|---|---|
| `.all()` | `Row[]` | — |
| `.first()` | `Row \| null` | — |
| `.one()` | `Row` | lança se 0 ou >1 |
| `.oneOrNull()` | `Row \| null` | lança se >1 |
| `.scalar()` | valor da 1ª coluna da 1ª linha `\| null` | — |
| `.scalars()` | valor da 1ª coluna de todas as linhas `[]` | — |
| (mutações sem `returning`) | `number` (linhas afetadas) | — |

O tipo já vem do builder: `session.execute(select(User)).all()` é `Promise<UserRow[]>`
sem anotação. Em mutações, o **guard de estado** da Fase 2 entra aqui: `execute`
aceita só `update`/`del` com `Guarded = true` — full-table write acidental = erro
de compilação **na borda de execução**.

```ts
// ❌ erro de compilação: update sem where/unguarded não é aceito por execute
session.execute(update(User).set({ age: 0 }));
```

---

## 3. Transações — commit/rollback automático

O caminho recomendado: bloco transacional que faz commit no sucesso e rollback em
exceção. Espelha `async with session.begin():` / `with engine.begin() as conn:`.

```ts
// engine.transaction: abre session + transação, commit/rollback automático
const order = await engine.transaction(async (tx) => {
  await tx.execute(insert(Order).values({ userId, amount }));
  await tx.execute(update(User).set({ orders: sql.raw("orders + 1") }).where({ id: userId }));
  return tx.execute(select(Order).where({ userId })).first();
  // commit automático aqui; se qualquer await lançar → rollback automático
});
```

Manual, quando precisar de controle fino:

```ts
const session = engine.session();
await session.begin();                       // inicia transação explícita
await session.execute(/* ... */);
await session.commit();                       // ou session.rollback()
```

### Savepoints (transação aninhada)

```ts
await engine.transaction(async (tx) => {
  await tx.execute(insert(User).values(a));
  try {
    await tx.beginNested(async (sp) => {       // SAVEPOINT
      await sp.execute(insert(User).values(b)); // se falhar, só esse savepoint reverte
    });
  } catch {
    // a transação externa continua viva; o savepoint reverteu
  }
  await tx.execute(insert(User).values(c));
});
```

### Regras de transação (espelhando SQLAlchemy)

- **Lazy begin**: a transação inicia na primeira query, não em `session()`.
- **Um commit por unit-of-work**: `commit()` finaliza; após isso, nova query inicia
  nova transação.
- **Rollback em exceção**: dentro de `engine.transaction`/`session.begin`, qualquer
  throw → rollback automático e o erro re-propaga.
- **Auto-rollback em erro de DB**: um erro de execução marca a transação como
  inválida; só `rollback()` é permitido até reabrir (igual SQLAlchemy).
- **`using`/`Symbol.asyncDispose`**: `await using session = engine.session()` fecha
  e faz rollback de transação pendente ao sair do escopo (TS 5.2+).

---

## 4. Isolamento async vs sync (mesma API, tipos diferentes)

A API é **idêntica em forma**; só muda `await`. Gerada a partir de um core comum
parametrizado pelo "executor" (async devolve `Promise`, sync devolve o valor).

=== "Async (padrão)"

    ```ts
    const engine = createEngine("postgresql://app@localhost/app");
    const session = engine.session();
    const users = await session.execute(select(User)).all();
    await session.close();
    ```

=== "Sync (SQLite)"

    ```ts
    const engine = createSyncEngine("sqlite:///app.db");
    const session = engine.session();
    const users = session.execute(select(User)).all();  // sem await
    session.close();
    ```

!!! tip "Quando usar sync"
    Scripts de seed, CLI, testes, ferramentas embarcadas com SQLite. Em servidor
    HTTP, **use async** — sync bloqueia o event loop.

---

## 5. Arquitetura interna

```text
URL ──parseDatabaseUrl──► { dialect, driver, ... }
                               │
                               ▼
                         createEngine ──► Engine { pool, dialect, executor }
                                              │
                                  engine.session()  /  engine.transaction(fn)
                                              │
                                              ▼
                                   Session { conn, txState }
                                              │ execute(builder)
                                              ▼
              builder.node (AST das Fases 1-2) ──► Dialect.compile(node)
                                              ▼
                                   { sql, params }  ──► driver.query(sql, params)
                                              ▼
                          linhas cruas ──► mapRow (coerção por ColumnType, reusa serialize.ts)
                                              ▼
                                   Result { all/first/one/scalar }
```

Pontos-chave:

- **`Dialect.compile(node)`** é o único lugar que vira SQL — sempre parametrizado
  (`$1`/`?`), nunca interpolação (anti-SQL-injection).
- **`mapRow`** reusa a coerção por `ColumnType` já implementada em `src/serialize.ts`
  (driver devolve string pra `bigint`/`numeric`/`Date`? a coerção normaliza).
- O **executor** abstrai async/sync: `AsyncExecutor` retorna `Promise`,
  `SyncExecutor` retorna o valor — o resto do código é compartilhado.

---

## 6. Drivers (peer deps, já declarados)

| Dialeto | Driver | Modo |
|---|---|---|
| SQLite | `better-sqlite3` | sync nativo; async = wrap |
| PostgreSQL | `postgres` (postgres.js) | async |

Detectados pela URL; sobrescrevíveis via `EngineOptions.driver`. Lazy-import (só
carrega o driver do dialeto em uso), igual o SDK Python só instala os extras que
usa.

---

## 7. Riscos / pontos abertos

- **Wrap async do `better-sqlite3`**: ele é sync; o "async" é cosmético (resolve na
  microtask). Documentar que SQLite não tem I/O async real — não enganar.
- **Mapeamento de pool do `postgres.js`**: ele já tem pool próprio; nosso
  `PoolOptions` precisa mapear pros parâmetros dele em vez de reimplementar.
- **DDL transacional**: Postgres faz DDL em transação; bom pras migrações (Fase 6).
- **`AsyncDisposable`**: depende de TS 5.2+/runtime com `Symbol.asyncDispose` — ok
  pro nosso alvo (Node ≥ 20, TS ≥ 5.7).
- **Streaming de result sets grandes**: `.stream()` (async iterator) provável adição
  pós-MVP pra não materializar tudo em memória.

---

## 8. Entrega faseada (dentro da Fase 4)

1. **4a — Dialect.compile** das ASTs das Fases 1-2 (SQLite + Postgres), saída
   `{ sql, params }`. Testável sem conexão (snapshot de SQL).
2. **4b — Async engine + pool + Session + Result** (SQLite async primeiro, depois
   Postgres). `mapRow` via `serialize.ts`.
3. **4c — Transações**: `begin`/`commit`/`rollback`, `engine.transaction`, savepoints.
4. **4d — Sync engine** (SQLite via `better-sqlite3`), compartilhando o core.
5. **4e — Ergonomia**: `using`/asyncDispose, `echo`, `.stream()`, pre-ping/recycle.
