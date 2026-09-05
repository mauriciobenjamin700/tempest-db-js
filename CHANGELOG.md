# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o
projeto adota [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

> Ciclo de trabalho sobre as issues #24–#51. A publicação no npm sai **uma vez**, no
> fim do ciclo — cada entrega entra aqui até lá.

### ⚠️ Breaking

- **O 3º parâmetro de `SyncSession`/`AsyncSession` passou de `QueryLogger` para
  `QueryHooks`** (`{ onQuery, onQueryEnd, slowQueryMs }`), e o mesmo nos construtores de
  `SyncEngine`/`AsyncEngine`. Quem usa `createEngine`/`createSyncEngine` não é afetado;
  quem instanciava sessão ou engine à mão passando a função de log troca
  `logger` por `{ onQuery: logger }` (#29).

- **SQLite passa a verificar `FOREIGN KEY`.** Antes a verificação ficava desligada (o
  default do próprio SQLite, por conexão), então `INSERT` órfão passava e
  `ON DELETE CASCADE` nunca disparava. Agora o engine liga na abertura de toda conexão
  SQLite, nos dois drivers. Base que já tinha linha órfã passa a recusar a escrita que
  a toca — o que é o ponto. Escape: `{ sqlite: { foreignKeys: false } }` (#24).

### Adicionado

- **Backup e restore, no CLI e programáticos** — `tempest-db backup <arquivo> --url` e
  `tempest-db restore`, mais `backupDatabase`/`restoreDatabase`. PostgreSQL usa
  `pg_dump`/`pg_restore`/`psql` com o formato escolhido **pela extensão** (`.sql` plano,
  o resto custom), e a senha vai por `PGPASSWORD` — nunca em `argv`, que qualquer
  processo da máquina lê. SQLite usa **`VACUUM INTO`**, não cópia de arquivo: com WAL
  ligado o `.db` sozinho não é o banco inteiro, e o `VACUUM INTO` é consistente mesmo com
  outra conexão escrevendo. Sufixo de driver (`postgresql+asyncpg`) é removido antes de
  chamar a ferramenta, e ferramenta ausente vira `BackupToolMissing`. Os dois comandos são
  despachados **antes** de carregar o config de migração — banco que ainda não migra é
  justamente o que precisa de dump (#44).

- **Trilha de auditoria append-only** — `auditLogModel(tabela)` para o schema e
  `enableAudit(Model, { log, actor, exclude })` para ligar. Uma entrada por
  create/update/delete, com `rowKey` (chave composta inteira), ação, ator resolvido **na
  hora da escrita** e um diff `{ coluna: [antes, depois] }` que traz **só o que mudou** —
  update sem delta não gera entrada. Implementado sobre os signals (#36), então a entrada
  é escrita na mesma session e, portanto, na mesma transação da mudança: rollback leva a
  entrada junto, porque trilha que registra mudança não-commitada é pior que trilha
  nenhuma (#43).

- **`TenantScopedRepository`** — repository preso a um tenant: o predicado entra em
  **toda** leitura e a coluna é carimbada em **toda** escrita, porque os métodos do
  `BaseRepository` passam a atravessar um ponto único de escopo (`scopeFilters` /
  `scopeWrite`, protegidos e sobrescrevíveis) em vez de cada um lembrar do `WHERE`. Linha
  de outro tenant é "não encontrada", não "proibida" — distinguir já seria vazamento —, e
  escrever nomeando outro tenant **lança** em vez de ser sobrescrito em silêncio. Modelo
  sem a coluna faz o construtor lançar (#42).

- **`engine.explain(fn)`** — captura o plano de **todo** statement que um bloco roda,
  com os parâmetros que o código realmente usou (o bloco recebe uma session gravadora).
  `EXPLAIN (FORMAT JSON)` no PostgreSQL, `EXPLAIN QUERY PLAN` no SQLite, mais um
  `summary()` legível por plano. `analyze: true` **executa** o statement para medir, então
  é recusado em escrita — analisar um `UPDATE` o aplicaria duas vezes — e o SQLite lança,
  porque `EXPLAIN ANALYZE` não existe lá (#41).

- **Outbox transacional** — `outboxModel(tabela)` para o schema e `OutboxRepository`
  para o relay: `publish`, `pending`, `claim`, `markSent`, `markFailed` com backoff e
  desistência permanente. `claim` usa `FOR UPDATE SKIP LOCKED` sobre subquery, então dois
  relays concorrentes pegam lotes **disjuntos**, e incrementa `attempts` no próprio claim,
  o que dá a política de dead letter de graça. `publish()` **não** abre transação própria
  de propósito: a atomicidade vem do `transaction()` re-entrante, com a linha de negócio
  e o evento na mesma session — um `saveWithOutbox` seria um segundo jeito de fazer a
  mesma coisa (#40).

- **Operações de conjunto: `union`, `unionAll`, `intersect` e `except`** — combinam dois
  ou mais SELECTs num builder executável como qualquer outro, com a **forma dos ramos
  verificada em tempo de compilação** (é o erro que o banco só reporta em runtime).
  `orderBy`/`limit`/`offset` valem para o conjunto; ramo com ordenação ou limite próprios
  é **parentetizado**, senão aquelas cláusulas passariam a valer para o combinado — outra
  query. `INTERSECT`/`EXCEPT` no MySQL lançam, por escopo (#39).

- **`exists` / `notExists` e `scalar`** — `EXISTS (...)` correlacionado, que é a forma
  certa quando só importa a existência (o banco para na primeira linha que casa, o que um
  `IN` sobre conjunto materializado não faz), e subquery escalar como valor. `scalar()`
  recebe o resultado de `.asSubquery(coluna)`, então uma subquery escalar de duas colunas
  vira erro de **compilação** em vez de erro de runtime no banco (#38).
- **`where` aceita expressão na forma objeto** — `{ userId: col("users.id") }` compara
  duas colunas, e `{ total: { gt: col("paid") } }` também. Antes, expressão nessa posição
  era **ligada como parâmetro**: a comparação virava coluna contra a string
  `"users.id"`, silenciosamente. Referência qualificada (`tabela.coluna`) passou a ser
  resolvida como `"tabela"."coluna"` em vez de virar um identificador só (#38).

- **`BaseRepository`: `existsExcluding`, `bulkUpsert`, `softDelete`/`restore`,
  `deleteBatch` e `changesSince`** — as operações que todo serviço reescrevia por cima
  do builder. `changesSince` é o read de delta sync: filtro **estrito** por `updatedAt`,
  ordem do mais antigo, desempate pela PK, e um `serverTime` lido **antes** da query como
  marca d'água (usar o maior `updatedAt` recebido deixaria a linha commitada durante a
  página cair no vão entre dois pulls). Linha soft-deletada volta como tombstone, que é o
  que faz o cliente apagar a cópia local. `softDelete`/`restore`/`changesSince` lançam
  nomeando o mixin quando o modelo não tem a coluna (#37).
- **`sql.excluded(coluna)`** — referencia a linha que está entrando num upsert
  (`excluded."col"` no PostgreSQL/SQLite, `VALUES(col)` no MySQL). Sem isso, um upsert de
  N linhas não tem como escrever o valor novo, porque cada linha tem o seu (#37).

- **Signals do repositório** — `preSave`, `postSave`, `preDelete` e `postDelete` em
  volta de `create`/`createMany`/`update`/`delete`, por linha. Handler que lança num
  `pre*` **veta** a escrita; o payload traz a **mesma session**, então handler que
  escreve comita (ou faz rollback) junto com a escrita observada. `update`/`delete`
  recebem filtro, não linha, então a leitura extra que entrega a linha ao handler só
  acontece quando existe handler (`hasHandlers`) — sem uso, custo zero. `clearSignals`
  para teste (#36).

- **Busca de texto: `contains`, o operador `iContains`, `escapeLike`, `fullText` e
  `fullTextRank`** — a camada portátil tokeniza o termo e **escapa** cada token, com a
  cláusula `ESCAPE` emitida sempre (o PostgreSQL assume `\\` por padrão, o **SQLite não
  tem escape nenhum** até declarar um). Antes, o operando de `like`/`ilike` ia cru: quem
  buscava `100%` casava com a tabela inteira. A camada do PostgreSQL usa
  `to_tsvector`/`websearch_to_tsquery`/`ts_rank` e, fora dele, **compila como
  `contains`** — as linhas certas, sem stemming, degradação documentada em vez de erro.
  `escapeLike` existia só na docstring do `ilike`; agora existe de verdade (#35).
- **`orderBy` aceita expressão** além de nome de coluna — sem isso não há como ordenar
  por relevância (#35).

- **`parseIntegrityError`** — lê o erro do driver de volta para a constraint que
  recusou a escrita: `{ violation, constraint, table, columns, detail }`, ou `null`
  quando não é violação de integridade. É o que separa `409 EMAIL_TAKEN` de um conflito
  genérico sem cada serviço escrever a própria regex. Segue a cadeia de `cause` (então o
  `QueryExecutionError` não atrapalha), entende as **duas** formas de reportar código do
  SQLite (`node:sqlite` numérico, `better-sqlite3` nomeado) e o SQLSTATE + `DETAIL:` do
  PostgreSQL — de onde saem **todas** as colunas de uma constraint composta. Passando o
  modelo, os nomes voltam como propriedade em vez de coluna. MySQL devolve `null`, por
  escopo (#34).

- **`pool.prePing` e `pool.recycleMs`** — o que faltava para conexão que morre sem
  avisar (failover, restart de pgbouncer, firewall cortando socket ocioso).
  `prePing` valida a conexão com `SELECT 1` **antes de pinar para a transação**, que é
  onde o estrago é pior: `BEGIN` passa e o bloco morre pela metade. `recycleMs` vira o
  `max_lifetime` do postgres.js. Os dois são PostgreSQL: no MySQL **lançam**, porque o
  mysql2 não tem knob equivalente, e no SQLite o bloco `pool` não se aplica (#33).

- **Nível de isolamento e bloco somente-leitura por transação** —
  `transaction(fn, { isolation, readOnly })`. O PostgreSQL põe tudo no próprio `BEGIN`;
  o MySQL precisa de um `SET TRANSACTION` antes e usa `START TRANSACTION READ ONLY`; o
  SQLite só implementa `serializable` e **lança** para qualquer outro nível ou para
  `readOnly`, em vez de aceitar em silêncio uma garantia que não dá. Característica
  pedida em bloco aninhado também lança: isolamento é fixado quando a transação abre
  (#32).

- **`caseWhen` e `cast`** — `CASE WHEN ... THEN ... ELSE ... END` e `CAST(x AS tipo)`
  como expressões de primeira classe. Os ramos do `CASE` usam a mesma linguagem de
  `where`, sem gramática nova, e o alvo do `CAST` é um vocabulário portátil que cada
  dialeto renderiza com o nome que aceita (`integer` é `INTEGER` no PostgreSQL e no
  SQLite, `SIGNED` no MySQL). Antes as duas saíam por `sql.raw`, perdendo tipo (#31).
- **Agregação sobre expressão** — `sum`/`avg`/`min`/`max` passam a aceitar expressão
  além de nome de coluna, que é o que torna a agregação condicional
  (`SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END)`) expressável: uma passada na
  tabela em vez de uma query por bucket (#31).

- **`transaction()` re-entrante** — bloco aninhado na mesma sessão adere ao de fora:
  um `BEGIN`, um `COMMIT`, e a falha interna faz rollback do conjunto. É o que faz um
  service que orquestra vários repositories funcionar, já que todos seguram a mesma
  sessão. `session.transactionDepth` e `session.inTransaction` expõem o estado (#30).
- **`AsyncSession.beginNested`** — savepoint no caminho **async**, que só existia no
  `SyncSession` apesar de a referência da API documentar `session.beginNested(fn)` sem
  qualificar. O caminho async é o default do PostgreSQL, justamente onde savepoint mais
  importa: era impossível recuperar falha parcial sem derrubar a transação inteira (#30).

- **`onQueryEnd` e `slowQueryMs` em `EngineOptions`** — o par do `onQuery`, que dispara
  **antes** do statement e por isso não mede nada. O novo hook dispara depois, com
  `durationMs`, `rowCount` e — no caminho de erro — o `error` do driver: statement lento
  que ainda falha é o que mais interessa. `slowQueryMs` filtra por limiar, o que dá um
  log de query lenta sem agente de APM. Em `stream()`, o tempo vai até o fim da
  iteração. Erro lançado no hook é engolido, como nos outros (#29).

- **`BaseRepository.cursorPaginate`** — paginação por cursor: `{ items, nextCursor }`,
  sem `COUNT(*)` e com fronteira estável sob insert concorrente, que é o que a
  paginação por offset não dá em tabela grande. A **chave primária é sempre anexada
  como desempate** (composta entra inteira), então empate no `orderBy` não faz linha
  sumir entre páginas. O cursor é opaco e validado: corrompido, de outra versão ou
  gerado com outro `orderBy` lança `InvalidCursor` em vez de montar um `WHERE` errado.
  A comparação é escrita na forma expandida (`a > v OR (a = v AND b > w)`), não como
  row value, porque o suporte a tupla varia entre os bancos (#27).
- **`encodeColumnValue` / `decodeColumnValue`** — os codecs por coluna que a
  serialização já usava, agora exportados: é o que permite guardar um valor de coluna
  fora do banco (num cursor, num cache) e trazê-lo de volta com o tipo certo.

- **Mixins de modelo** — `withTimestamps` (`createdAt`/`updatedAt`), `withSoftDelete`
  (`deletedAt`, mais `notDeleted()`/`onlyDeleted()` para o `where`) e `withAudit`
  (`createdBy`/`updatedBy`, com o tipo do autor configurável por fábrica). São funções
  que recebem a classe base e devolvem a subclasse, então compõem
  (`withAudit(withSoftDelete(withTimestamps(Model)))`) e contribuem colunas de verdade:
  aparecem no `InferModel`, no `InferInsert`, no IR de migração e no DDL (#26).
- **`defaultAsWriteValue`** — converte o default guardado numa coluna
  (`DefaultValue`) para o que o caminho de escrita renderiza. Era a peça que faltava
  entre o formato do IR e o de `set()`/`values()`.

- **`EngineOptions.sqlite`** — pragmas por conexão aplicados na abertura:
  `foreignKeys` (default `true`), `journalMode`, `busyTimeoutMs`, `synchronous`. Cada
  um é **relido depois de escrito**, porque o SQLite responde a um pragma que não pode
  honrar mantendo o valor antigo e não dizendo nada: `journalMode: "wal"` num banco
  `:memory:` agora lança em vez de fingir. `sqlite` num engine PostgreSQL/MySQL lança
  (#28).

### Corrigido

- **Statement que devolve linha era decidido por um regex incompleto.** O caminho do
  `node:sqlite` escolhe entre `all()` e `run()` antes de executar, e o teste cobria só
  `SELECT`/`PRAGMA` — então `EXPLAIN`, `WITH ... SELECT`, `VALUES` e `TABLE` eram rodados
  como se não devolvessem nada e reportavam **zero linha**, em silêncio, em vez de falhar.
  O `better-sqlite3` não sofria (ele pergunta ao statement), o que deixava os dois drivers
  discordando (#41).

- **`sql.now()` no SQLite gravava num formato que o próprio pacote não lê.**
  `CURRENT_TIMESTAMP` produz `"YYYY-MM-DD HH:MM:SS"` — sem `T`, sem milissegundo, sem
  fuso —, e o JS parseia isso como horário **local**: uma linha escrita às 21:00Z era
  lida como 00:00Z numa máquina UTC-3. Pior, comparar a coluna contra um `Date` ligado
  (ISO) comparava `" "` com `"T"` e não casava nada, em silêncio. Agora o SQLite
  renderiza `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, exatamente o formato que o pacote
  liga e lê. Afeta o default do DDL e o valor de `onUpdate`; base já gravada com o
  formato antigo precisa de um `UPDATE` de conversão (#37).

- **`Column.onUpdate()` passou a ser aplicado.** O valor era guardado na coluna e
  **nunca consumido** — nem no DDL, nem no builder —, então `.onUpdate(sql.now())`
  não fazia nada, apesar de a receita `created_at / updated_at` documentar que "o valor
  é reaplicado a cada UPDATE". Agora o `UpdateBuilder` injeta o valor de toda coluna com
  `onUpdate` que o `set()` não menciona. Aplicado na escrita, não no schema: só o MySQL
  tem `ON UPDATE` de coluna, e renderizar no DDL faria o mesmo modelo divergir por
  banco. Valor explícito no `set()` continua vencendo (#26).

- **Chave primária composta é respeitada inteira** no `BaseRepository` e no
  `activeRecord`. As duas camadas tinham uma cópia de `primaryKeyOf` que devolvia a
  **primeira** coluna marcada `primaryKey()` e seguia: `getById`, `update`, `delete`,
  `reload` e o `ON CONFLICT` do `save()` filtravam por metade da chave e podiam ler ou
  escrever a linha errada. Agora a resolução mora num lugar só — `primaryKeysOf` e
  `primaryKeyFilter`, ambos exportados —, `getById` aceita `{ orderId, lineNumber }`, e
  um escalar em chave composta **lança** em vez de casar meia chave. Chave de uma
  coluna continua aceitando o valor cru (#25).

## [0.8.0] — 2026-09-05

O `better-sqlite3` deixou de ser promessa: `EngineOptions.driver` e o sufixo
`sqlite+better-sqlite3` passaram a selecionar driver de verdade.

### Adicionado

- **`BetterSqliteDriver`** — driver SQLite sobre a peer dependency opcional
  `better-sqlite3`, exportado no índice público e com o mesmo cache de prepared
  statement do `NodeSqliteDriver`. Linhas, coerção (`bigint`, `Date`, `boolean`,
  JSON), `RETURNING` e `stream()` são idênticos entre os dois — trocar de driver
  não muda o código do consumidor. O pacote é carregado **lazy**, como `postgres`
  e `mysql2`, e a falta dele dá erro nomeando o `npm install`.
- **Seleção de driver de verdade** — `{ driver: "better-sqlite3" }` e
  `sqlite+better-sqlite3:///app.db` abrem o `better-sqlite3`; a opção vence o
  sufixo quando os dois aparecem. `node:sqlite` continua o padrão, sem instalar
  nada. Receita nova: *Escolhendo o driver do SQLite*.

### ⚠️ Breaking

- **`EngineOptions.driver` com nome desconhecido agora lança.** Antes o campo era
  ignorado em silêncio para qualquer valor, em qualquer dialeto — quem passava
  `{ driver: "better-sqlite3" }` rodava no `node:sqlite` sem aviso. Agora
  `"sqlite3"` no SQLite, `"asyncpg"` no PostgreSQL e `"mysql3"` no MySQL falham na
  criação do engine. É breaking em runtime só para quem já estava sendo ignorado,
  que é exatamente o engano que a issue #22 registrou.
- O **sufixo da URL** continua tolerante de propósito: `sqlite+aiosqlite`,
  `postgresql+asyncpg` e afins são ignorados, não rejeitados, para URL copiada de
  serviço Python continuar conectando.

### Corrigido

- **`EngineOptions.driver`, o sufixo `+better-sqlite3` e a peer dependency
  opcional eram documentados e ignorados** (#22). `openSqliteDriver` nunca lia
  `options.driver` nem `parsed.driver`, e nenhuma linha de `src/` carregava
  `better-sqlite3`. Quem escolhia o driver — por WAL, `pragma()`, extensão
  carregável, ou por já usá-lo no resto do serviço — rodava em outro sem saber.

## [0.7.0] — 2026-08-30

Duas correções vindas do mesmo consumidor real (`zap-api`): o ruído que o
`InferInsert` obrigava a escrever, e o `NOTICE` do Postgres sujando o stdout do
serviço.

### ⚠️ Breaking

- **Coluna anulável passou a ser opcional em `InferInsert`.** É uma frouxidão de
  tipo, então nenhum código que compilava para de compilar — mas quem derivava
  tipos de `InferInsert` esperando as anuláveis obrigatórias vê a forma mudar
  (`nickname: string | null` → `nickname?: string | null`).
- **`NOTICE` do PostgreSQL não é mais impresso.** Sem `onNotice`, ele é
  descartado; antes o postgres.js o imprimia via `console.log`. Quem dependia
  desse print precisa passar `onNotice`.

### Adicionado

- **`onNotice` em `EngineOptions`** — recebe os notices do servidor
  (`CREATE TABLE IF NOT EXISTS` numa tabela existente, `DROP ... IF EXISTS`), no
  mesmo espírito do `onQuery`, com erro do logger engolido. **O default é
  silenciar:** escrever no stdout do processo hospedeiro é decisão da aplicação,
  não de uma biblioteca — e o default anterior quebrava o log estruturado de
  quem consome stdout (Docker, Loki, CloudWatch) a cada boot, já que um runner de
  migration é a primeira coisa que roda.
- **`driverOptions` em `EngineOptions`** — repasse direto para o driver, aplicado
  **por último** (vence `pool` e `onNotice`), para o que a superfície tipada não
  modela: `connection`/`types`/`transform`/`ssl` do postgres.js, ajustes do
  mysql2, `readOnly` do `node:sqlite`. Evita que cada gap vire feature request.

### Corrigido

- **Coluna anulável sem default exigia `campo: null` em todo insert.** Omitir uma
  coluna que aceita `NULL` e não declara `DEFAULT` grava `NULL` — o mesmo que
  passar `null`. Exigir o `null` escrito à mão só adicionava ruído que **lê como
  decisão deliberada de zerar a coluna**, e fazia toda coluna nova adicionada por
  migration quebrar a compilação de todos os call sites de insert. Agora `notNull`
  sem default é a única coisa obrigatória; `null` explícito continua aceito.
- **Insert de várias linhas descartava chave ausente na primeira linha.** A lista
  de colunas vinha de `values[0]`, então em
  `values([{ a }, { a, note: "x" }])` o `note` nunca era nomeado e o valor sumia
  sem erro. Agora a lista é a **união** das chaves de todas as linhas. Era
  inalcançável enquanto toda linha precisava carregar toda chave — e passou a ser
  alcançável no instante em que anulável virou opcional.
- **Linhas que discordam sobre coluna com default** agora levantam
  `ValidationError`. Um `INSERT` tem uma lista de colunas só, então a linha que
  omite receberia `NULL` em vez do default; o SQLite não tem a palavra `DEFAULT`
  dentro de `VALUES`, então não há saída portável por linha — falhar alto é a
  opção honesta.

### Limitações conhecidas

- `EngineOptions.driver` (`"better-sqlite3"`) continua **documentado e não
  implementado**: `openSqliteDriver` sempre usa `node:sqlite`. `driverOptions`
  cobre as opções do driver, não a troca de driver.

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
