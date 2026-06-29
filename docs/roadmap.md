# Roadmap

O tempest-db-js é construído em fases, cada uma entregando uma fatia testável. As Fases
0–2 estão concluídas (provadas por `tsc`); o resto é o caminho à frente.

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
contra full-table writes. Tudo como AST pura, executável na Fase 4. Ver
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

### Fase 5 — Joins (MVP feito)

`join(Model, alias).innerJoin/leftJoin(...)` → tipos compostos
(`{ user: UserRow; order: OrderRow }`), com nullability correta em outer joins. Ver
[Joins](tutorial/joins.md). Falta: operadores tipados no `where` de join e relations
declarativas (`hasMany`/`belongsTo`) pra eager-load.

### Fase 6 — Migrações (feito)

`reflectSchema`/`diffSchema`/`generateMigration`/`MigrationRunner` + grafo DAG + **CLI**
(`runMigrationCli`) + **drift** (`checkDrift`/`introspectSqlite`) + **batch-mode SQLite**
+ **enum nomeado PG**, estilo Alembic, anti-"costura de SQL". Ver [Migrações](migrations.md).

### Fase 7 — Repository (feito) + SDK

`BaseRepository<Model>` (CRUD + paginação tipada) + **relations** (`hasMany`/`belongsTo`).
Ver [Repository](repository.md). Falta: o pacote `tempest-ts-sdk` consumindo o tempest-db-js
e receitas de integração HTTP (Express/Hono/Fastify).

## À frente

### Próximos refinamentos

Joins: operadores tipados-por-coluna no `where`. Execução: `using`/asyncDispose,
benchmark vs Drizzle/Kysely. Migrações: rename interativo, bin executável.
PostgreSQL: validar introspecção/enum/pool contra um banco real.

!!! info "Detalhes completos no repositório"

    O `ROADMAP.md` na raiz do repositório tem a linha do tempo detalhada, riscos e
    decisões de design por fase.
