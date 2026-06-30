# Roadmap

O tempest-db-js é construído em fases, cada uma entregando uma fatia testável. **As
Fases 0–7 estão concluídas** e publicadas na `v0.1.0`; o que resta são refinamentos
e a integração com o `tempest-ts-sdk`.

| Fase | Tema | Status |
| --- | --- | --- |
| 0 | Toolchain + CI + testes de tipo | ✅ Concluída |
| 1 | Schema declarativo class-based + inferência | ✅ Concluída |
| 2 | Query builder tipado (SELECT/INSERT/UPDATE/DELETE) | ✅ Concluída |
| 3 | Operadores tipados por tipo de coluna | ✅ Concluída |
| 4 | Dialetos + execução real (`Session`) | ✅ + `.stream()`/pool; falta `using`/benchmark |
| 5 | Joins + tipos compostos + relations | ✅ + relations + and/or/not |
| 6 | Migrações + CLI | ✅ + CLI + drift + batch SQLite + enum PG |
| 7 | Integração `tempest-ts-sdk` + comunidade | ✅ BaseRepository feito; SDK a fazer |

## Concluído

### Fase 1 — Schema declarativo

Classe `Model` + fábrica `column` com modificadores encadeáveis. Tipos de linha
inferidos por `InferModel` (SELECT) e `InferInsert` (INSERT), com nullability e
opcionalidade corretas. Ver [Modelos](tutorial/models.md).

### Fase 2 — Query builder tipado

`select` com projeção `Pick`, `where`/`orderBy`/`limit`/`offset`; `insert` tipado por
`InferInsert` com `.returning()`; `update`/`del` com **guard de estado tipado**
contra full-table writes. AST pura, executada pela camada de sessão (Fase 4). Ver
[Consultas](tutorial/queries.md) e [Mutações](tutorial/mutations.md).

### Fase 3 — Operadores tipados

Operadores restritos por tipo de coluna em tempo de compilação: `like` só em
`string`, `gt`/`lt`/`between` só em `number`/`bigint`/`Date`, etc. `like` num número
**não compila**. Ver [Consultas](tutorial/queries.md).

```ts
select(User).where({
  age:  { gt: 18 },        // ✅
  name: { like: "%Ben%" }, // ✅
  // age: { like: "%x%" }  // ❌ erro de compilação
});
```

### Fase 4 — Execução real (4a + 4b feitos)

`getDialect(...).compile(node)` → `{ sql, params }` parametrizado (4a). `createEngine`
(async) / `createSyncEngine` (SQLite sync), `Session.execute` com terminais tipados
(`.all()`, `.first()`, `.one()`, `.scalar()`...), `engine.transaction` e savepoints
(4b). SQLite roda via `node:sqlite`; PostgreSQL via `postgres.js`. Ver
[Executando queries](tutorial/execution.md). Falta 4c-4e (pool tuning, `using`,
`.stream()`, benchmark).

### Fase 5 — Joins + relations

`join(Model, alias).innerJoin/leftJoin(...)` → tipos compostos
(`{ user: UserRow; order: OrderRow }`), com nullability correta em outer joins, mais
relations declarativas `hasMany`/`belongsTo` + `loadRelations` (eager-load sem N+1) e
combinadores `and`/`or`/`not`. Ver [Joins](tutorial/joins.md) e
[Repository](repository.md). Falta: operadores tipados-por-coluna no `where` de join.

### Fase 6 — Migrações (feito)

`reflectSchema`/`diffSchema`/`generateMigration`/`MigrationRunner` + grafo DAG + **CLI**
(`runMigrationCli`) + **drift** (`checkDrift`/`introspectSqlite`) + **batch-mode SQLite**
+ **enum nomeado PG**, estilo Alembic, anti-"costura de SQL". Ver [Migrações](migrations.md).

### Fase 7 — Repository (feito) + SDK

`BaseRepository<Model>` (CRUD + paginação tipada) + **relations** (`hasMany`/`belongsTo`).
Ver [Repository](repository.md). Falta: o pacote `tempest-ts-sdk` consumindo o tempest-db-js
e receitas de integração HTTP (Express/Hono/Fastify).

## À frente

### Bancos suportados — foco em 3

O tempest-db-js mira **exatamente três bancos: SQLite, PostgreSQL e MySQL** — nessa
ordem, e nenhum outro por enquanto.

| Banco | Status |
| --- | --- |
| **SQLite** | ✅ Completo e testado (`node:sqlite`). |
| **PostgreSQL** | 🟢 Execução real, transações (conexão reservada), PK auto-incremento (`SERIAL`), enum nomeado, introspecção e drift — **testados contra um Postgres real no CI**. Falta o runner de migração async (hoje o `MigrationRunner` é síncrono/SQLite). |
| **MySQL** | ⏳ Próximo dialeto, **após** o fluxo SQLite + PostgreSQL fechar. |

### Próximos refinamentos

Fechar o último item do **PostgreSQL** — um **runner de migração assíncrono** (o
`MigrationRunner` atual é síncrono, então migrações em Postgres ainda são aplicadas
renderizando o DDL e executando pela sessão) — e então adicionar o dialeto **MySQL**.
Joins: operadores tipados-por-coluna no `where`. Execução: `using`/asyncDispose,
benchmark vs Drizzle/Kysely. Migrações: rename interativo, bin executável.

!!! info "Detalhes completos no repositório"

    O `ROADMAP.md` na raiz do repositório tem a linha do tempo detalhada, riscos e
    decisões de design por fase.
