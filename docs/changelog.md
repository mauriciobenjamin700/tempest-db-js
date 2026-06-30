# Changelog

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o
projeto adota [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [0.1.0] — 2026-06-29

Primeira versão pública, publicada no [npm](https://www.npmjs.com/package/tempest-db-js).

### Adicionado

- **Fase 1 — Schema declarativo class-based.** Classe base `Model` + fábrica
  `column` com catálogo rico de tipos espelhando o SQLAlchemy (`smallInteger`,
  `integer`, `bigInteger`→`bigint`, `numeric`/`decimal`→`string`, `real`, `double`,
  `varchar`/`string`, `char`, `text`, `boolean`, `date`, `time`, `datetime`,
  `timestamp`, `blob`→`Uint8Array`, `json<T>`/`jsonb<T>`, `uuid`, `enum`→união
  literal). Modificadores `.primaryKey()`, `.notNull()`, `.default()`,
  `.onUpdate()`. Tipos inferidos por `InferModel` (SELECT) e `InferInsert` (insert).
- **Defaults portáveis** (`sql.now()`, `sql.uuidv4()`, etc.), guardados na coluna
  pro IR de migração.
- **`parseDatabaseUrl`/`detectDialect`** — banco identificado via URL (à la
  `make_url`).
- **Serialização** (`toDict`/`toJSON`/`stringify`/`fromDict`/`parse`) com coerção
  por tipo de coluna.
- **Fase 3 — operadores tipados por tipo de coluna** (`OperatorsFor<T>`): `string`→
  `like`/`ilike`/`in`; `number`/`bigint`/`Date`→ordenados+`between`; `boolean`→
  eq/`isNull`. Combinação inválida = erro de compilação.
- **Fase 4a — compilação SQL por dialeto**: `getDialect(...).compile(node)` →
  `{ sql, params }` parametrizado (`?`/`$1`), SELECT/INSERT/UPDATE/DELETE +
  `RETURNING`; `ilike` nativo no Postgres.
- **Fase 4b — execução real**: `createEngine` (async) / `createSyncEngine` (SQLite
  sync), `Session.execute` com terminais tipados, `engine.transaction` + savepoints,
  coerção de linha. SQLite via `node:sqlite`; PostgreSQL via `postgres.js`.
- **Fase 5 — joins tipados**: `join(Model, alias).innerJoin/leftJoin(...)` → tipo
  composto `{ [alias]: Row }`, `leftJoin` nullable; refs `alias.column` tipadas.
- **Fase 6 — migrações** (`tempest-db-js/migrations`, estilo Alembic): `reflectSchema`,
  `diffSchema`, operações tipadas + `invert`, `renderOperation` (DDL por dialeto),
  `generateMigration`, grafo DAG (`topoOrder`/`heads`), `MigrationRunner`
  (`upgrade`/`downgrade` reais). SQL só no renderer.
- **Fase 7 — repository**: `BaseRepository<Model>` (CRUD + paginação tipada) sobre
  `AsyncSession`, convenção 404 (`RecordNotFound`/`[]`), `PaginationFilter`/
  `PaginationResult` alinhados ao `tempest-fastapi-sdk`.
- **Refinamentos**: combinadores `and`/`or`/`not` no `where` (select/update/delete/
  join); batch-mode SQLite (`recreate_table`) pra mudanças de coluna preservando
  dados; introspecção SQLite + `checkDrift` (compara DB vivo com os modelos).
- **Mais refinamentos**: `session.stream(query)` (iteração preguiçosa sync/async);
  relations `hasMany`/`belongsTo` + `loadRelations` (eager-load tipado, sem N+1);
  CLI de migração `runMigrationCli` (`upgrade`/`downgrade`/`check`/`revision
  --autogenerate`); PostgreSQL estrutural (introspecção, enum nomeado, `PoolOptions`).
- **Fase 2 — Query builder tipado (AST pura, sem execução).**
    - `select(Model)` / `select(Model, [cols])` → inferência de linha completa ou
      `Pick`, com `.where()`, `.orderBy()`, `.limit()`, `.offset()`.
    - `insert(Model).values(...)` tipado por `InferInsert`, com `.returning()`.
    - `update(Model)` / `del(Model)` com **guard de estado tipado**: a query só se
      torna executável após `.where(...)` ou `.unguarded()` explícito — um
      UPDATE/DELETE em tabela inteira sem querer vira erro de compilação.
    - `.returning(cols)` inferindo projeção `Pick` em todas as mutações.
- Documentação bilíngue (PT-BR + EN-US) em MkDocs Material, publicada no GitHub
  Pages.

### Notas

- Alpha (`v0.1.0`). A superfície pública pode ainda mudar antes da `v1.0`.
- Execução SQLite real e testada (`node:sqlite`); PostgreSQL via `postgres.js`.
