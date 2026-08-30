# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o
projeto adota [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [0.6.0] — 2026-08-30

Fecha as cinco lacunas que sobraram do ciclo anterior (#13–#17): a query API
avançada, o MySQL de verdade e o CLI de migração fora do SQLite.

### ⚠️ Breaking

- **`runMigrationCli` agora é `async`** e devolve `Promise<CliResult>`.
  `CliConfig.driver` aceita `SyncDriver | AsyncDriver`. Quem chama a função
  direto precisa de `await`; o binário `tempest-db` já foi ajustado.

  ```diff
  - const result = runMigrationCli(["upgrade"], config);
  + const result = await runMigrationCli(["upgrade"], config);
  ```

- **`SelectBuilder` ganhou um terceiro parâmetro de tipo** (`Grouped`, default
  `false`), que é o que torna `.having()` inalcançável antes de `.aggregate()`.
  Uma anotação `SelectBuilder<Row, Proj>` passa a significar "não agrupado"; para
  aceitar os dois, escreva `SelectBuilder<Row, Proj, boolean>`.

### Adicionado

- **Subquery em `IN`/`NOT IN`** — `.asSubquery(coluna)` projeta uma coluna e marca
  o `SELECT` como operando, então a reivindicação de lote da fila cabe numa query
  só (`UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)`). A
  subquery carrega o próprio mapa de nomes e binda seus parâmetros na posição em
  que aparece. MySQL recusa `LIMIT` em subquery — erro explícito na compilação.
- **`HAVING`** — `.having(input)` depois de `.aggregate()`, com as chaves tipadas
  contra os aliases + colunas agrupadas. O compilador reemite a **expressão**
  (`COUNT(*) > $1`) porque o PostgreSQL não aceita alias no `HAVING`; `.orderBy()`
  passa a aceitar alias de agregação, que todo dialeto aceita.
- **Expressões no `where`** — `col<Row>("coluna")`, `val(x)` e `fn.*`
  (`lower`/`upper`/`trim`/`length`/`abs`/`coalesce` portáveis, `fn.call` para o
  resto) tornam expressáveis a comparação **coluna vs coluna** e o índice
  funcional. Referência de coluna passa pelo mapa de nomes e pela qualificação de
  join; operando que não é expressão continua sendo ligado como parâmetro.
- **`RETURNING` no MySQL** — `.returning()` funciona num insert de **uma** linha:
  a sessão insere e lê a linha de volta por `LAST_INSERT_ID()` (ou pela PK
  fornecida) na **mesma conexão**, reservando-a fora de transação. É o que faz
  `BaseRepository.create()` e `activeRecord.save()` funcionarem no MySQL. Insert
  de N linhas com `.returning()` lança, porque `LAST_INSERT_ID()` só identifica a
  primeira.
- **CLI de migração async** — `runMigrationCli` roda sobre o
  `AsyncMigrationRunner` para todo dialeto, adaptando o driver com
  `toAsyncDriver`. `check` roteia por dialeto via `checkDriftAsync`
  (`introspectSqliteAsync` novo; PostgreSQL pelo `information_schema`; MySQL
  devolve mensagem explícita de não implementado). **Migração pelo CLI no
  PostgreSQL destravada.**
- **CI** — job `mysql` com serviço MySQL 8 real; o job `postgres` passa a rodar
  também o teste ponta-a-ponta do CLI. `mysql2` declarada como peer dependency
  opcional (o código já a importava dinamicamente, sem declarar).
- **Docs** — receitas bilíngues novas "Expressões no `where`" e "MySQL: o que
  muda"; "Fila durável" ganhou a versão numa query só; "Agregações" ganhou
  `HAVING`; "Migrações" ganhou o fluxo async/PostgreSQL.

### Corrigido

- **`introspectSqlite` e a comparação de drift** foram fatoradas para que os
  caminhos sync e async compartilhem uma implementação só — uma segunda cópia
  divergiria da primeira na próxima mudança de regra.
- **`Expression` dentro de `in`/`between`** era serializada como parâmetro em vez
  de virar SQL; agora levanta erro na montagem, mesmo princípio do guard de
  `set()`.

### Limitações conhecidas

- Subquery só em `IN`/`NOT IN`; `EXISTS` e subquery escalar continuam fora.
- Introspecção MySQL (`information_schema`) não existe, então `check` não detecta
  drift lá.
- `col()`/`fn.*` checam o **nome** da coluna, não o tipo do operando — comparar
  uma coluna de texto com uma numérica compila.

## [0.5.0] — 2026-08-30

Ciclo focado nos buracos que a primeira migração real de um serviço (`zap-api`,
gateway WhatsApp) encontrou — o padrão outbox/fila sobre PostgreSQL, ponta a ponta.

### Adicionado

- **Lock de linha** — `.forUpdate({ skipLocked, noWait, of })` e `.forShare(...)`
  no `SelectBuilder` (espelha `with_for_update()` do SQLAlchemy). Renderiza
  `FOR UPDATE [OF ...] [SKIP LOCKED | NOWAIT]` no PostgreSQL e no MySQL 8.0+;
  o SQLite **lança erro explícito** em vez de emitir um `SELECT` sem lock. Lock
  combinado com `DISTINCT`/agregação também lança. Destrava o padrão de fila com
  workers concorrentes.
- **Expressões SQL como valor de escrita** — `sql.raw("attempts + 1")`,
  `` sql.expr`balance - ${amount}` `` (tagged template, cada `${}` vira parâmetro
  ligado) e os tokens portáveis (`sql.now()`, `sql.uuidv4()`, …) agora valem em
  `.set()` e `.values()`, não só em `.default()`. O contador é incrementado no
  banco, sem read-modify-write e sem race. Toda expressão carrega uma marca
  (`isSqlExpression`) que o dialeto reconhece.
- **Predicado no conflict target** — `onConflictDoNothing(target, { where })` e
  `onConflictDoUpdate(target, set, { indexWhere, updateWhere })` emitem
  `ON CONFLICT (...) WHERE <predicado>`, obrigatório no PostgreSQL para que um
  **índice único parcial** case como conflict target. Portável para o SQLite;
  MySQL lança erro explícito.
- **`session.raw(sql, params, { as })`** — escape hatch de SQL cru em runtime,
  paralelo do `Op.execute` das migrações, nas sessões async e sync. Sempre
  parametrizado, integrado a `onQuery`, `QueryExecutionError` e à conexão
  reservada da transação; `{ as: Model }` coage as linhas pelos tipos do modelo.
- **Nome de coluna explícito e naming strategy** — `.name("consumer_name")` por
  coluna (estilo `mapped_column("...")`) e `static naming = "snake_case"` por
  tabela. O mapeamento vale em select/insert/update/delete, `where`, `orderBy`,
  `groupBy`, agregações, `returning`, conflict target, joins, `BaseRepository`,
  active-record **e no IR das migrações** — então não gera drift falso. A linha
  retornada continua em nome de propriedade. Colisão de nomes falha alto.
- **`column.array(element)`** — colunas `text[]`/`integer[]` do PostgreSQL, com
  `T[]` inferido, `DEFAULT ARRAY[...]::tipo[]`, introspecção (`data_type = ARRAY`
  + `udt_name`) e drift cientes do tipo do elemento. SQLite e MySQL lançam erro
  explícito em vez de cair para JSON silenciosamente.
- **Operadores novos** — `ieq` (igualdade case-insensitive → `lower(col) =
  lower($1)`, portável nos 3 dialetos e casando índice funcional) e os operadores
  de array `contains` (`@>`), `containedBy` (`<@`) e `overlaps` (`&&`),
  PostgreSQL-only.
- **Docs** — cinco receitas bilíngues novas: Fila durável com PostgreSQL, Nomes de
  coluna, Colunas array do PostgreSQL, Comparação case-insensitive e SQL cru em
  runtime. Suíte de integração contra PostgreSQL real cobrindo lock concorrente,
  índice parcial, arrays e contador atômico.

### Corrigido

- **`set()`/`values()` gravavam lixo em silêncio.** Um valor não-escalar —
  `{ raw: "attempts + 1" }`, um array numa coluna escalar, uma função — era
  **ligado como parâmetro**, e o driver o serializava (ou gravava `null`) sem
  erro nenhum: uma coluna `INTEGER NOT NULL` virava `null`. Agora qualquer valor
  que não seja escalar nem expressão marcada levanta `ValidationError` na
  montagem da query, junto com o nome da coluna e o tipo esperado. Chave que não
  é coluna do modelo também é rejeitada.
- **Cache de template do INSERT** não podia servir statements com predicado de
  conflito ou expressão nos valores, cuja SQL depende dos valores. Esses casos
  passam por um caminho não-cacheado que renderiza as cláusulas em ordem de
  statement, mantendo as posições dos placeholders corretas.
- **Introspecção do PostgreSQL** lia toda coluna array como `text`, o que fazia o
  `checkDriftPostgres` reportar drift eterno num schema correto.

### Documentado

- `ilike` é **pattern matching**, não igualdade: `%` e `_` são coringas, e
  `{ ilike: "%" }` casa todas as linhas. Usado como "eq case-insensitive" num
  lookup de autenticação, é bypass de login. A doc do operador agora diz isso, e
  `ieq` existe justamente para eliminar a tentação.

### Limitações conhecidas

- `FOR UPDATE`/`FOR SHARE`, predicado de `ON CONFLICT` e `column.array()` não têm
  equivalente em todos os dialetos; cada um lança erro explícito onde não é
  suportado, em vez de degradar em silêncio.
- Subquery em `WHERE ... IN (...)` continua fora do builder — o padrão de fila é
  escrito como `SELECT ... FOR UPDATE SKIP LOCKED` seguido de
  `UPDATE ... WHERE id IN (ids)` na mesma transação, ou via `session.raw`.

## [0.4.0] — 2026-07-09

### Adicionado

- **Chaves estrangeiras** — `.references("tabela.coluna", { onDelete, onUpdate })`
  por coluna (espelha `mapped_column(ForeignKey(...))` do SQLAlchemy). Ações
  `cascade`/`restrict`/`set null`/`set default`/`no action` renderizadas nos 3
  dialetos como FK inline em `CREATE TABLE`.
- **UNIQUE por coluna** — `.unique()` (espelha `mapped_column(unique=True)`).
  Metadado de DDL puro: não altera `InferModel`/`InferInsert`.
- **Constraints de tabela** — `static tableArgs = () => [...]` (estilo
  `__table_args__`) com helpers `unique(...)` e `foreignKey(cols, refTable,
  refCols, opts)` para UNIQUE composto, FK composta e constraints nomeadas.
  Nomes determinísticos (`uq_<tabela>_<cols>` / `fk_<tabela>_<cols>`) quando
  omitidos.
- **IR + pipeline** — `ColumnIR` ganha `unique`/`references`; `TableIR` ganha
  `uniqueConstraints`/`foreignKeys`. Operações reversíveis `add_constraint` /
  `drop_constraint` (invert ↔), com replay e codegen. Diff detecta constraints
  de tabela adicionadas/removidas/alteradas por nome.
- **DDL** — cláusulas `CONSTRAINT ... UNIQUE (...)` / `CONSTRAINT ... FOREIGN KEY
  (...) REFERENCES ...` em `CREATE TABLE`; `ALTER TABLE ADD CONSTRAINT` /
  `DROP CONSTRAINT` (PostgreSQL), `DROP INDEX` / `DROP FOREIGN KEY` (MySQL).
- **Drift** — introspecção SQLite lê FK (`PRAGMA foreign_key_list`) e UNIQUE
  (`PRAGMA index_list`/`index_info`); Postgres via `pg_constraint`. `checkDrift`
  compara constraints de forma normalizada (coluna e tabela tratadas igual).
- **Docs** — receita bilíngue "Chaves estrangeiras e UNIQUE".

### Limitações conhecidas

- SQLite não suporta `ALTER` de constraint em tabela existente — o diff direciona
  para um rebuild de tabela (`recreate_table`), mesmo caminho do `alter_column`.

## [0.3.0] — 2026-07-01

### Adicionado

- **Migração async** (`AsyncMigrationRunner`) — runner de migração sobre
  `AsyncDriver`, espelhando o sync (`ensureVersionTable`/`applied`/`upgrade`/
  `downgrade`), tudo awaited. Quoting + placeholders por dialeto tornam a
  version-table portável. Destrava migração real no PostgreSQL.
- **Dialeto MySQL** (`MysqlDialect`) — 3º banco do escopo. URL `mysql://`
  (+ alias `mariadb`); identificadores com crase, placeholders `?`,
  `ON DUPLICATE KEY UPDATE` (upsert), `LIKE` case-insensitive; DDL MySQL
  (`INT`/`BIGINT`/`VARCHAR`/`DATETIME`/`TINYINT(1)`/`JSON`/`CHAR(36)`/`ENUM`
  nativo, `AUTO_INCREMENT`, `RENAME TABLE`, `MODIFY COLUMN`); driver
  `mysql2/promise` (lazy) via `createEngine("mysql://...")`.

### Limitações conhecidas

- MySQL não tem `RETURNING` — `.returning()` lança no dialeto MySQL (use
  insert + SELECT por chave). Integração async do CLI `tempest-db` e execução
  MySQL no CI ficam como follow-up.

## [0.2.0] — 2026-07-01

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
