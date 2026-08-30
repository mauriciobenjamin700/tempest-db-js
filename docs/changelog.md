# Changelog

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

- **Chaves estrangeiras, UNIQUE e constraints de tabela** — `.references(...)` e
  `.unique()` por coluna (estilo `mapped_column(ForeignKey(...), unique=True)`) e
  `static tableArgs = () => [unique(...), foreignKey(...)]` para composto/nomeado
  (estilo `__table_args__`). Renderizados nos 3 dialetos, com operações reversíveis
  `add_constraint`/`drop_constraint`, diff, replay e detecção de drift. Veja a
  receita [Chaves estrangeiras e UNIQUE](recipes/constraints.md).

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
