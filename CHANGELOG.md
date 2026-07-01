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
- **`using` / `await using`** — `Session` e `Engine` (sync e async) implementam
  `Symbol.dispose`/`Symbol.asyncDispose`, fechando driver/pool ao sair do escopo.
- **Binário `tempest-db`** — CLI executável que carrega um config
  (`tempest-db.config.{mjs,js,cjs}` ou `--config <path>`) e despacha os comandos de
  migração; `defineMigrationConfig` para config tipada.
- **Rename interativo** — `detectRenames`/`applyRenames` reconhecem pares add/drop
  de shape idêntico como rename (1:1 sem ambiguidade) e os fundem em
  `rename_column`/`rename_table`. CLI: `--autorename`, `--rename-table from:to`,
  `--rename-column tbl.from:to`; o bin pergunta por candidato quando em TTY.
- **Operadores tipados-por-coluna no `where` de join** — cada ref `alias.column`
  aceita `OperatorsFor<T>` da coluna (como o `WhereInput` single-table); `like` em
  número / `gt` em string = erro de compilação.
- **Receitas HTTP** — exemplos bilíngues de REST API com `BaseRepository` sobre
  **Hono**, **Express** e **Fastify**.
- **Benchmark** — `npm run bench` (`bench/sqlite-bench.mjs`) compara insert/scan/
  filter/lookup vs Drizzle e Kysely; resultados e metodologia em `BENCHMARKS.md`.

### DX & API

- **Erros de query com contexto** — `QueryExecutionError` envolve o erro do
  driver e anexa o SQL que falhou + os params. Todo statement do session
  (execute/stream/transaction/savepoint) reporta contexto no throw.
- **Logging opcional de query** — `EngineOptions.onQuery` (`QueryLogger`),
  chamado por statement com `{ sql, params }`. Erros do logger são engolidos.
- **`SELECT DISTINCT`** — `select(...).distinct()`.
- **Agregações tipadas** — helpers `count`/`sum`/`avg`/`min`/`max` +
  `select(M).aggregate(groupBy, spec)`. Linha resultante = colunas de grupo
  (do modelo) + `{ [alias]: resultado }`; compila `GROUP BY`.
- **Upsert** — `insert(M).onConflictDoNothing(target)` /
  `onConflictDoUpdate(target, set)` → `ON CONFLICT (...) DO NOTHING | DO UPDATE`.
- **Active-record opt-in** — `activeRecord(Model, session)` +
  `ActiveRecord` com `save`/`update`/`delete`/`reload` sobre `.data` (linha
  plana). Não altera o retorno plano default — é explícito.

### Performance

- **Cache de prepared-statement** no `NodeSqliteDriver` — `prepare()` por texto
  SQL, reusado entre execuções (tempest sempre parametriza, então a forma de
  query mapeia pra um SQL estável). Maior ganho em insert/lookup.
- **`columnsOf` memoizado** por classe (WeakMap) — antes reinstanciava o modelo
  a cada linha lida.
- **Row-mapper compilado** — `coerceRow` monta um mapa de decoders por coluna
  (só as que precisam de coerção), memoizado por modelo, em vez de re-dispatchar
  o switch de tipo por linha.
- **Cache do template SQL de INSERT** por estrutura (`dialeto|tabela|colunas|
  nº de linhas|returning`) — o texto do INSERT independe dos valores, então o
  loop de insert por linha compila a string uma vez e reusa; params seguem
  extraídos por chamada.
- Efeito medido (20k linhas, `node:sqlite`): insert 64ms→18ms, scan 22ms→9ms,
  lookups 5ms→1.9ms. tempest-db-js passa a ser o mais próximo do piso `node:sqlite`
  entre os ORMs comparados (~10× mais rápido que Drizzle no insert).

### Notas

- Pré-alpha (`v0.0.0`). A superfície pública ainda muda. Não publicado no npm.
- Execução real contra banco (dialetos SQLite/PostgreSQL, `Session`) chega na
  Fase 4 — ver [Roadmap](ROADMAP.md).
