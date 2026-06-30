# Conectando ao PostgreSQL

**Problema:** você desenvolveu em SQLite e agora quer rodar a mesma aplicação em
PostgreSQL — sem reescrever queries, e ajustando o pool de conexões pra produção.

**Solução:** o banco é identificado pela **URL**. Trocar de SQLite pra PostgreSQL é
trocar a string de conexão; o mesmo modelo, as mesmas queries e migrações valem pros
dois. O PostgreSQL roda via `postgres.js` (async-only).

## A teoria em uma frase

`createEngine(url)` faz parse da URL (`parseDatabaseUrl`), escolhe o dialeto, e instancia
o driver certo. O dialeto compila a **mesma AST** pra SQL idiomática de cada banco
(`?` no SQLite, `$1` no Postgres; `ILIKE` nativo no Postgres).

## 1. Instale o driver

SQLite usa o `node:sqlite` embutido; PostgreSQL precisa do `postgres`:

```bash
npm install postgres
```

## 2. Troque a URL

```ts
import { createEngine } from "tempest-db-js";

// dev
const dev = createEngine("sqlite:///app.db");

// produção — só a string muda
const prod = createEngine("postgresql://app:secret@db.internal:5432/app");
```

!!! info "Sufixo de driver async é aceito"

    URLs no estilo SQLAlchemy com sufixo de driver (`postgresql+asyncpg://...`,
    `sqlite+aiosqlite://...`) são aceitas — o sufixo é ignorado, o dialeto vem do scheme
    base. Útil pra reusar a mesma `DATABASE_URL` de um backend Python.

## 3. Ajuste o pool (produção)

PostgreSQL é async e usa um **pool de conexões**. Ajuste pelo segundo argumento:

```ts
const engine = createEngine("postgresql://app:secret@db.internal/app", {
  pool: {
    size: 10,             // máx. de conexões simultâneas
    idleTimeoutMs: 30_000, // fecha conexões ociosas após 30s
    connectTimeoutMs: 5_000, // desiste de conectar após 5s
  },
});
```

!!! note "Pool é ignorado no SQLite"

    SQLite é uma conexão única (sync ou async) — as opções de pool não se aplicam e são
    silenciosamente ignoradas. Só passe `pool` pra PostgreSQL.

## 4. Tudo async

PostgreSQL **não tem** engine síncrono (não existe driver sync sério no Node) —
`createSyncEngine` lança em Postgres. Use `createEngine` e `await`:

```ts
import { select } from "tempest-db-js";

const session = engine.session();
const users = await session.execute(select(User).where({ active: true })).all();
await session.close();
```

O resto da API é idêntico ao SQLite — terminais (`.all`/`.first`/`.one`/…), transações,
streaming e o guard de mutação funcionam igual. Veja [Executando queries](../tutorial/execution.md).

## 5. Migrações no Postgres

A mesma migração roda nos dois bancos, com DDL idiomática por dialeto — basta dizer o
dialeto ao runner:

```ts
const runner = new MigrationRunner(driver, "postgresql"); // em vez de "sqlite"
```

No PostgreSQL, `column.enum(...)` vira um **`CREATE TYPE ... AS ENUM`** nomeado, e
`alter_column` é um `ALTER` direto (sem o table-rebuild que o SQLite exige). Veja o
[Fluxo de migrações](../examples/migrations-workflow.md).

!!! warning "PostgreSQL ainda não roda no CI do projeto"

    A introspecção, o enum nomeado e o pool existem e são compilados, mas ainda não são
    exercitados contra um Postgres real no CI (só SQLite é). Trate o caminho Postgres
    como **beta** e valide no seu ambiente — veja o [Roadmap](../roadmap.md).

## Recap

- Banco identificado pela **URL** — trocar de banco é trocar a string.
- `createEngine(url, { pool: { size, idleTimeoutMs, connectTimeoutMs } })` pra Postgres.
- PostgreSQL é **async-only**; SQLite ignora o pool.
- Mesmo modelo, queries e migrações nos dois; DDL idiomática por dialeto.
