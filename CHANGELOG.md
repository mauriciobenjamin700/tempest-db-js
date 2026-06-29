# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o
projeto adota [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado

- **Fase 1 — Schema declarativo class-based.** Classe base `Model` + fábrica
  `column` com catálogo rico de tipos espelhando o SQLAlchemy: `smallInteger`,
  `integer`, `bigInteger` (→`bigint`), `numeric`/`decimal` (→`string`), `real`,
  `double`, `varchar`/`string`, `char`, `text`, `boolean`, `date`, `time`,
  `datetime`, `timestamp`, `blob` (→`Uint8Array`), `json<T>`/`jsonb<T>`, `uuid`,
  `enum` (→união literal). Modificadores encadeáveis `.primaryKey()`, `.notNull()`,
  `.default()`, `.onUpdate()`. Tipos de linha inferidos por `InferModel` (SELECT) e
  `InferInsert` (PK/default opcionais).
- **Defaults portáveis** via namespace `sql` (`sql.now()`, `sql.currentDate()`,
  `sql.currentTime()`, `sql.uuidv4()`, `sql.raw()`) — renderizados por dialeto;
  guardados na coluna (`defaultValue`/`onUpdateValue`) pro IR de migração.
- **`parseDatabaseUrl` / `detectDialect`** — identificação de banco via URL (à la
  `make_url` do SQLAlchemy), com strip de sufixo de driver async. Trocar de banco
  = trocar a string.
- **Serialização** (`toDict`, `toJSON`, `stringify`, `fromDict`, `parse`) — linha
  ↔ dict ↔ JSON com coerção por tipo de coluna (`bigint`↔string, `Date`↔ISO,
  `Uint8Array`↔base64, JSON parse), validação de obrigatórios via `ValidationError`.
- **`columnsOf(Model)`** — reflexão de colunas em runtime.
- **Fase 3 — operadores tipados por tipo de coluna.** `OperatorsFor<T>` +
  `WhereInput`: `string`→`like`/`ilike`/`in`/eq; `number`/`bigint`/`Date`→ordenados
  (`gt`/`gte`/`lt`/`lte`)+`between`+`in`; `boolean`→eq/`isNull`. Shorthand de valor
  bare = `eq`. Combinações inválidas (ex.: `like` em número) = erro de compilação.
- **Fase 4a — compilação SQL por dialeto.** `getDialect("sqlite"|"postgresql")` →
  `BaseDialect.compile(node)` → `{ sql, params }` parametrizado (`?` / `$1`), nunca
  interpolação. Cobre SELECT/INSERT/UPDATE/DELETE, todos os operadores de WHERE e
  `RETURNING`. `ilike` nativo no Postgres, `LIKE` no SQLite.
- **Fase 4b — execução real.** `createEngine` (async, default) / `createSyncEngine`
  (SQLite, sync). `Session.execute(builder)` infere o retorno; terminais
  `.all/.first/.one/.oneOrNull/.scalar/.scalars/.rowsAffected`; `engine.transaction`
  (commit/rollback automático) e `beginNested` (savepoints); coerção de linha por
  tipo de coluna. SQLite via `node:sqlite` embutido (testes rodam SQL real);
  PostgreSQL via `postgres.js` (lazy). Guard de UPDATE/DELETE aplicado na borda de
  `execute`.
- **Fase 5 — joins tipados.** `join(Model, alias).innerJoin/leftJoin(Model, alias,
  on)` → linha composta `{ [alias]: Row }`; `leftJoin` torna o lado nullable.
  `on`/`where`/`orderBy` por refs `alias.column` tipadas. Dialeto compila JOIN com
  aliasing; execução faz split da linha em composto coagido por source.
- **Fase 6 — migrações** (subpath `tempest-db-js/migrations`), estilo Alembic: `reflectSchema`
  (model→IR), `diffSchema` (IR×IR→operações tipadas), `invert`/`invertAll`,
  `renderOperation` (DDL por dialeto), `generateMigration` (codegen TS com `down()`
  invertido), grafo **DAG** (`topoOrder`/`heads`/ciclo), `MigrationRunner` (`Op` facade
  + version table + `upgrade`/`downgrade` reais). Tudo flui por IR + operações; SQL só
  nasce no renderer. Falta 6d (introspecção/drift) + 6e (batch SQLite, enum nomeado).
- **Fase 7 — repository tipado**: `BaseRepository<Model>` (`list`/`first`/`getById`/
  `getByIdOrNull`/`exists`/`count`/`create`/`createMany`/`update`/`delete`/`paginate`)
  sobre `AsyncSession`, tipado por `InferModel`/`InferInsert`/`WhereInput`. Convenção
  404 (`getById`→`RecordNotFound`; coleções→`[]`). `PaginationFilter`/`PaginationResult`
  espelham o `tempest-fastapi-sdk`.
- **Design docs**: [`MIGRATIONS_DESIGN.md`](MIGRATIONS_DESIGN.md) (Fase 6, estilo
  Alembic) e [`SESSION_DESIGN.md`](SESSION_DESIGN.md) (Fase 4, engine/Session/pool/
  transações, async-first + sync opcional).
- **Fase 2 — Query builder tipado (AST pura, sem execução).**
  - `select(Model)` / `select(Model, [cols])` → inferência de linha completa ou
    `Pick`, com `.where()`, `.orderBy()`, `.limit()`, `.offset()`.
  - `insert(Model).values(...)` tipado por `InferInsert`, com `.returning()`.
  - `update(Model)` / `del(Model)` com **guard de estado tipado**: a query só
    se torna executável após `.where(...)` ou `.unguarded()` explícito — um
    UPDATE/DELETE em tabela inteira sem querer vira erro de compilação.
  - `.returning(cols)` inferindo projeção `Pick` em todas as mutações.
- Documentação bilíngue (PT-BR + EN-US) em MkDocs Material, publicada no
  GitHub Pages.

### Refinamentos

- **Combinadores `and`/`or`/`not`** no `where` — unificados em select/update/delete/join
  via uma árvore `Condition`; o compilador renderiza recursivamente (`(...) OR (...)`,
  `NOT (...)`). A forma objeto continua sendo AND implícito.
- **Batch-mode SQLite** (`recreate_table`): mudanças de coluna que o SQLite não faz
  por `ALTER` viram table-rebuild (cria nova → copia colunas comuns → renomeia),
  preservando dados. No PostgreSQL vira ALTER/ADD/DROP por coluna.
- **Introspecção SQLite + drift** (`introspectSqlite`, `checkDrift`): lê o schema vivo
  via `PRAGMA` e compara com os modelos no nível de afinidade do SQLite (sem
  falso-positivo de `varchar` vs `TEXT`).
- **`.stream()`** — iteração preguiçosa de resultados (`session.stream(query)`), sync
  (`node:sqlite` iterate) e async (`for await`), sem materializar todas as linhas.
- **Relations** (`hasMany`/`belongsTo` + `loadRelations`) — eager-load tipado, **1
  query por relação** (sem N+1); resultado widened (`Row[]` / `Row | null`).
- **CLI de migração** (`runMigrationCli`): `current`/`history`/`heads`/`upgrade
  [--sql]`/`downgrade [N]`/`check` (gate de CI)/`revision --autogenerate` — núcleo
  programático testável; `replaySchema` habilita autogenerate a partir do diff.
- **PostgreSQL** (estrutural, sem PG no CI): `introspectPostgres`/`checkDriftPostgres`
  via `information_schema`; **enum nomeado** (`CREATE TYPE ... AS ENUM`); `PoolOptions`
  (`size`/`idleTimeoutMs`/`connectTimeoutMs`) repassados ao `postgres.js`.

### Notas

- Pré-alpha (`v0.0.0`). A superfície pública ainda muda. Não publicado no npm.
- Execução real contra banco (dialetos SQLite/PostgreSQL, `Session`) chega na
  Fase 4 — ver [Roadmap](ROADMAP.md).
