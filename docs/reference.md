# Referência da API

Superfície pública completa do tempest-db-js. O núcleo importa do nível do pacote; as
migrações vivem no subcaminho `tempest-db-js/migrations`:

```ts
import {
  Model, column, sql,
  type InferModel, type InferInsert,
  select, insert, update, del,
  and, or, not,
  createEngine, createSyncEngine,
  join, hasMany, belongsTo, loadRelations,
  BaseRepository,
} from "tempest-db-js";

import { reflectSchema, diffSchema, MigrationRunner } from "tempest-db-js/migrations";
```

!!! note "Referência viva"

    Esta página resume toda a superfície pública atual. A **fonte da verdade** são
    os docstrings JSDoc no código — o editor mostra a assinatura completa de cada
    símbolo no autocomplete.

## Schema

### `Model`

Classe base abstrata de toda tabela. Subclasses definem `static tablename` e campos
de coluna.

```ts
class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
}
```

### `column`

Fábrica de colunas tipadas (espelha os tipos genéricos do SQLAlchemy).

| Método | Tipo TS | Tipo SQL |
| --- | --- | --- |
| `column.array(element)` | `T[]` | `TEXT[]` / `INTEGER[]` (PostgreSQL) |
| `column.smallInteger()` | `number` | `SMALLINT` |
| `column.integer()` | `number` | `INTEGER` |
| `column.bigInteger()` | `bigint` | `BIGINT` |
| `column.numeric(p?, s?)` / `column.decimal(p?, s?)` | `string` | `NUMERIC(p,s)` |
| `column.real()` | `number` | `REAL` |
| `column.double()` | `number` | `DOUBLE PRECISION` |
| `column.varchar(n)` / `column.string(n)` | `string` | `VARCHAR(n)` |
| `column.char(n)` | `string` | `CHAR(n)` |
| `column.text()` | `string` | `TEXT` |
| `column.boolean()` | `boolean` | `BOOLEAN` |
| `column.date()` | `Date` | `DATE` |
| `column.time({ timezone? })` | `string` | `TIME` |
| `column.datetime({ timezone? })` | `Date` | `DATETIME`/`TIMESTAMP` |
| `column.timestamp({ timezone? })` | `Date` | `TIMESTAMP` |
| `column.blob()` | `Uint8Array` | `BLOB`/`BYTEA` |
| `column.json<T>()` | `T` | `JSON` |
| `column.jsonb<T>()` | `T` | `JSONB` |
| `column.uuid()` | `string` | `UUID` |
| `column.enum(...vals)` | união literal | `ENUM` |

Modificadores encadeáveis (retornam um novo `Column` com a flag aplicada):

| Modificador | Efeito |
| --- | --- |
| `.primaryKey()` | Marca como PK; implica `hasDefault`. |
| `.notNull()` | Torna o tipo inferido não-anulável. |
| `.default(value)` | Default no insert (valor `T` ou expressão de `sql`); marca opcional no insert. |
| `.onUpdate(value)` | Reaplica a cada UPDATE (ex.: `updated_at`). |

### `sql` — defaults portáveis

Expressões server-side, renderizadas por dialeto (à la `func` do SQLAlchemy):

| Função | Render | Uso |
| --- | --- | --- |
| `sql.now()` | `CURRENT_TIMESTAMP` / `now()` | `created_at`/`updated_at` |
| `sql.currentDate()` | `CURRENT_DATE` | data de criação |
| `sql.currentTime()` | `CURRENT_TIME` | hora |
| `sql.uuidv4()` | `gen_random_uuid()` / fallback | PK UUID |
| `sql.raw(expr)` | verbatim | escape hatch |
| `` sql.expr`...${v}` `` | fragmento parametrizado | expressão com valor ligado |

O default fica guardado em `column.<campo>.defaultValue` / `.onUpdateValue` —
alimenta o IR de migração.

Toda expressão `sql.*` é **marcada** (`isSqlExpression`) e serve tanto como default
de coluna quanto como valor de escrita em `.set()` / `.values()`, onde é renderizada
inline em vez de virar parâmetro:

```ts
update(Outbound)
  .set({ attempts: sql.raw("attempts + 1"), updatedAt: sql.now() })
  .where({ id });
```

!!! warning "`sql.expr` não pode ser default de coluna"

    Um `DEFAULT` não tem onde ligar parâmetros — `.default(sql.expr\`...\`)` lança
    erro na hora. Use `sql.raw()` ali.

### Nomes de coluna

| Símbolo | Faz |
| --- | --- |
| `.name("coluna")` | Mapeia a propriedade para outro nome de coluna. |
| `static naming` | `"preserve"` (default) ou `"snake_case"` para a tabela toda. |
| `columnNamesOf(Model)` | Mapa propriedade → coluna, ou `null` sem renomeações. |
| `columnPropsOf(Model)` | O mapa inverso, coluna → propriedade. |
| `toSnakeCase(name)` | A conversão usada pela estratégia `"snake_case"`. |

Veja a receita [Nomes de coluna](recipes/naming.md).

### `columnsOf(Model)`

Reflete a classe nos seus `Column` em runtime (`Record<string, Column>`). Base da
serialização e do reflector de schema das migrações.

### `InferModel<typeof Model>`

Tipo da **linha lida**. Colunas `notNull`/`primaryKey` são não-anuláveis; as demais
viram `T | null`.

### `InferInsert<typeof Model>`

Tipo da **linha a inserir**. Colunas com default (ou PK) são opcionais (`?`); o resto
é obrigatório.

## SELECT

### `select(Model)` / `select(Model, columns)`

| Forma | Resultado inferido |
| --- | --- |
| `select(User)` | `InferModel<typeof User>[]` |
| `select(User, ["id", "name"])` | `Pick<InferModel<typeof User>, "id" \| "name">[]` |

### `SelectBuilder<Full, Proj>`

| Método | Descrição |
| --- | --- |
| `.where(input)` | Filtra; chaves tipadas contra `Full`, operadores tipados por coluna. |
| `.orderBy(column, direction?)` | Ordena por coluna (`"asc"` \| `"desc"`, default `"asc"`). |
| `.limit(n)` | Limita o número de linhas. |
| `.offset(n)` | Pula as primeiras `n` linhas. |
| `.forUpdate(options?)` | `FOR UPDATE [OF ...] [SKIP LOCKED \| NOWAIT]`. PostgreSQL/MySQL; SQLite lança. |
| `.forShare(options?)` | Idem, com lock compartilhado (`FOR SHARE`). |
| `.aggregate(groupBy, spec)` | Agrupa; o builder passa a aceitar `.having()`. |
| `.having(input)` | `HAVING`, por alias de agregação ou coluna agrupada. Só depois de `.aggregate()`. |
| `.asSubquery(coluna)` | Projeta uma coluna e marca o SELECT como operando de `in`/`notIn`. |
| `.node` | A AST `SelectNode` (read-only). |

`LockOptions` = `{ skipLocked?: boolean; noWait?: boolean; of?: readonly string[] }`.
`skipLocked` e `noWait` são mutuamente exclusivos, e um lock combinado com
`DISTINCT`/agregação lança erro na compilação.

### Operadores de `where` (`OperatorsFor<T>`)

Cada valor de `where` aceita um match exato (shorthand de `eq`) ou um objeto de
operador restrito ao tipo da coluna:

| Tipo | Operadores permitidos |
| --- | --- |
| `string` | `eq`, `ne`, `in`, `notIn`, `like`, `ilike`, `ieq`, `isNull` |
| `number` / `bigint` / `Date` | `eq`, `ne`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `between`, `isNull` |
| `boolean` | `eq`, `ne`, `isNull` |
| `T[]` (array) | `eq`, `ne`, `in`, `notIn`, `contains`, `containedBy`, `overlaps`, `isNull` |
| json / blob | `eq`, `ne`, `in`, `notIn`, `isNull` |

!!! danger "`ilike` é pattern, `ieq` é igualdade"

    `%` e `_` são coringas em `like`/`ilike` — `{ ilike: "%" }` casa todas as
    linhas. Para lookup case-insensitive (login, e-mail) use `ieq`, que compila
    para `lower(col) = lower($1)` e casa índice funcional. Veja
    [Comparação case-insensitive](recipes/case-insensitive.md).

Os operadores de array (`contains` → `@>`, `containedBy` → `<@`, `overlaps` →
`&&`) são nativos do PostgreSQL; os outros dialetos lançam erro explícito.

`OPERATORS` (runtime) e o tipo `Operator` listam o conjunto completo. Operador
inválido pro tipo = erro de compilação.

#### Expressões: `col`, `val`, `fn`

Para comparar coluna com coluna, ou aplicar função SQL:

| Símbolo | Faz |
| --- | --- |
| `col<Row>("coluna")` | Referência de coluna (nome de **propriedade**, checado contra `Row`). |
| `val(x)` | Valor ligado — necessário dentro de `fn.*`, onde string significa coluna. |
| `fn.lower/upper/trim/length/abs/coalesce` | Funções portáveis nos 3 dialetos. |
| `fn.call(nome, ...args)` | Qualquer função; o nome é validado como identificador e **interpolado**. |

Os métodos de comparação (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`,
`ieq`, `in`, `notIn`, `between`, `isNull`) devolvem uma `Condition`. Operando que
não é expressão vira parâmetro ligado; `in`/`between` **recusam** expressão.

```ts
select(Order).where(col<OrderRow>("total").gt(col<OrderRow>("paid")));
select(User).where(fn.lower("email").eq(fn.lower(val(probe))));
```

Detalhes em [Expressões no `where`](recipes/expressions.md).

#### Subquery em `in` / `notIn`

`in`/`notIn` aceitam uma lista **ou** um `Subquery` de uma coluna:

```ts
update(Outbound).set({ status: "sending" }).where({
  id: { in: select(Outbound).where({ status: "queued" }).asSubquery("id") },
});
```

A subquery carrega o próprio mapa de nomes e binda seus parâmetros na posição em
que aparece. O MySQL recusa `LIMIT` dentro dela (erro explícito na compilação).

#### Combinadores `and` / `or` / `not`

A forma objeto é AND implícito. Pra lógica composta, use os combinadores (em
select/update/delete/join):

| Símbolo | Faz |
| --- | --- |
| `and(...args)` | `(...) AND (...)` |
| `or(...args)` | `(...) OR (...)` |
| `not(arg)` | `NOT (...)` |

Cada `arg` é a forma objeto (`{ col: ... }`) ou outro combinador. Passe o tipo da
linha (`or<UserRow>(...)`) pra key-safety dentro do combinador.

## INSERT

### `insert(Model)`

Retorna `InsertBuilder`.

| Método | Descrição |
| --- | --- |
| `.values(row \| rows)` | Tipado por `InferInsert<typeof Model>`. Aceita 1 ou N. |
| `.onConflictDoNothing(target, options?)` | `ON CONFLICT (target) [WHERE ...] DO NOTHING`. |
| `.onConflictDoUpdate(target, set, options?)` | Upsert, com `indexWhere`/`updateWhere` opcionais. |
| `.returning()` | Resultado vira a linha completa. |
| `.returning(columns)` | Resultado vira `Pick` das colunas. |

Sem `returning`, o resultado da execução é `number` (linhas afetadas).

`OnConflictOptions` = `{ where? }` (o predicado de um índice único **parcial** —
obrigatório no PostgreSQL para que ele case como conflict target).
`OnConflictUpdateOptions` = `{ indexWhere?, updateWhere? }`. Ambos aceitam a mesma
linguagem de condição do `where`. O MySQL lança erro para qualquer predicado.

Valores de `.values()` e `.set()` aceitam o valor da coluna **ou** uma expressão
`sql.*`; qualquer outro objeto levanta `ValidationError` na montagem da query.

## UPDATE

### `update(Model)`

Retorna `UpdateBuilder<Full, false>` (não-guarded).

| Método | Descrição |
| --- | --- |
| `.set(values)` | `WritePatch<Full>` — só as colunas informadas mudam; aceita expressão `sql.*`. |
| `.where(input)` | Filtra **e** marca `Guarded = true`. |
| `.unguarded()` | Opt-in explícito pra atualizar todas as linhas (`Guarded = true`). |
| `.returning()` / `.returning(cols)` | Como no insert. |

## DELETE

### `del(Model)`

Retorna `DeleteBuilder<Full, false>` (`del` porque `delete` é reservado).

| Método | Descrição |
| --- | --- |
| `.where(input)` | Filtra **e** marca `Guarded = true`. |
| `.unguarded()` | Opt-in explícito pra deletar todas as linhas. |
| `.returning()` / `.returning(cols)` | Como no insert. |

## Tipos da AST

Expostos pra ferramentas e dialetos: `SelectNode`, `InsertNode`, `UpdateNode`,
`DeleteNode`, `OrderTerm`, `SortDirection`, `WhereInput`, `Returning`, `LockClause`,
`LockOptions`, `OnConflict`, `OnConflictOptions`, `OnConflictUpdateOptions`,
`WriteValues`, `WritePatch`, `NameMap`, `SqlExpression`, `ExprNode`, `Expression`,
`Subquery`.

## URL do banco

### `parseDatabaseUrl(url)`

Analisa uma string de conexão e identifica o dialeto, igual ao `make_url` do
SQLAlchemy. Aceita (e ignora) sufixo de driver async (`+asyncpg`, `+aiosqlite`).

```ts
import { parseDatabaseUrl, detectDialect } from "tempest-db-js";

parseDatabaseUrl("postgresql://app:secret@localhost:5432/mydb");
// { dialect: "postgresql", host: "localhost", port: 5432, user: "app",
//   password: "secret", database: "mydb", driver: null, options: {}, raw: "..." }

parseDatabaseUrl("sqlite:///app.db");      // { dialect: "sqlite", database: "app.db", ... }
detectDialect("sqlite://:memory:");        // "sqlite"
```

| Símbolo | Descrição |
| --- | --- |
| `parseDatabaseUrl(url)` | `ParsedDatabaseUrl` (dialeto + partes de conexão). |
| `detectDialect(url)` | Só o `Dialect` (`"sqlite" \| "postgresql"`). |
| `ParsedDatabaseUrl` | Tipo do resultado. |
| `InvalidDatabaseUrl` | Erro lançado em URL sem scheme ou dialeto desconhecido. |

## Serialização

Converte entre linha (valores nativos), dict e JSON, com coerção por tipo de
coluna — à la `model_dump` / `model_validate` do Pydantic.

```ts
import { toDict, toJSON, stringify, fromDict, parse } from "tempest-db-js";

toJSON(User, row);        // { ...JSON-safe: Date→ISO, bigint→string, blob→base64 }
toDict(User, row);        // { ...nativos, só colunas conhecidas }
stringify(User, row);     // string JSON
fromDict(User, payload);  // linha validada (coage string→Date/bigint/Uint8Array; JSON.parse)
parse(User, jsonString);  // fromDict(JSON.parse(...))
```

| Função | Faz |
| --- | --- |
| `toDict(Model, row)` | Dict de valores nativos, restrito às colunas. |
| `toJSON(Model, row)` | Objeto JSON-safe (`Date`→ISO, `bigint`→string, `Uint8Array`→base64). |
| `stringify(Model, row)` | `JSON.stringify(toJSON(...))`. |
| `fromDict(Model, data)` | Linha validada a partir de um dict; coage tipos; valida obrigatórios. |
| `parse(Model, json)` | `fromDict(Model, JSON.parse(json))`. |
| `ValidationError` | Lançado quando uma coluna obrigatória falta. |

## Compilação SQL (dialetos)

A AST de um builder vira SQL **parametrizado** via um dialeto — o único lugar onde
SQL nasce. Sempre placeholders (`?` no SQLite, `$1` no Postgres), nunca interpolação
(injection-safe por construção). O `compile` só monta a SQL; quem roda é a sessão
(veja **Execução** abaixo).

```ts
import { getDialect, select, Model, column } from "tempest-db-js";

const sqlite = getDialect("sqlite");
const compiled = sqlite.compile(
  select(User).where({ age: { gte: 18 } }).orderBy("name").limit(10).node,
);
// { sql: 'SELECT * FROM "users" WHERE "age" >= ? ORDER BY "name" ASC LIMIT ?',
//   params: [18, 10] }
```

| Símbolo | Descrição |
| --- | --- |
| `getDialect("sqlite" \| "postgresql")` | Instância de dialeto. |
| `BaseDialect.compile(node)` | `CompiledQuery` (`{ sql, params }`). |
| `SqliteDialect` / `PostgresDialect` | Implementações concretas. |
| `CompiledQuery` | `{ sql: string; params: readonly unknown[] }`. |
| `QueryNode` | União das ASTs compiláveis. |

Diferenças por dialeto: placeholder (`?` vs `$1`), `ilike` (nativo `ILIKE` no
Postgres; `LIKE` no SQLite, case-insensitive em ASCII), lock de linha
(`FOR UPDATE` no Postgres/MySQL, erro no SQLite), predicado de `ON CONFLICT`
(Postgres/SQLite, erro no MySQL) e arrays nativos (só Postgres).

## Execução (engine / sessão)

Banco identificado pela URL; execução **async por padrão**, sync opcional pra SQLite.

| Símbolo | Descrição |
| --- | --- |
| `createEngine(url, opts?)` | `AsyncEngine` (SQLite ou PostgreSQL). |
| `createSyncEngine(url, opts?)` | `SyncEngine` (SQLite; lança em Postgres). |
| `engine.session()` | Abre uma `Session`/`SyncSession`. |
| `engine.transaction(fn)` | Bloco transacional (commit/rollback automático). |
| `engine.close()` | Fecha o driver. |
| `session.execute(builder)` | Roda e coage; retorna um `Result`. |
| `session.raw(sql, params?, opts?)` | Statement cru **parametrizado**; mesmo `Result`. `{ as: Model }` coage as linhas. |
| `toAsyncDriver(driver)` | Adapta driver sync **ou** async à interface async (usado pelo CLI). |
| `session.stream(builder)` | Iteração preguiçosa (sync: `Iterable`; async: `AsyncIterable`). |
| `session.beginNested(fn)` | Savepoint (transação aninhada). |
| `createEngine(url, { pool })` | `PoolOptions` (`size`/`idleTimeoutMs`/`connectTimeoutMs`) — PostgreSQL. |

Terminais do `Result` (async retornam `Promise`):

| Terminal | Retorna |
| --- | --- |
| `.all()` | `Row[]` |
| `.first()` | `Row \| null` |
| `.one()` | `Row` (erro `NoResultError` se ≠ 1) |
| `.oneOrNull()` | `Row \| null` (erro se > 1) |
| `.scalar()` | valor da 1ª coluna `\| null` |
| `.scalars()` | valores da 1ª coluna `[]` |
| `.rowsAffected()` | `number` |

Drivers: SQLite via `node:sqlite` embutido (`NodeSqliteDriver`); PostgreSQL via
`postgres.js` (lazy). O guard de `update`/`del` é exigido por `execute` (tipo
`Executable`).

`session.raw` é a saída para a query que o builder ainda não expressa — passa pelo
mesmo `onQuery`, pelo mesmo `QueryExecutionError` e pela conexão reservada da
transação. Nunca interpole valores na string: eles vão em `params`. Veja
[SQL cru em runtime](recipes/raw-sql.md).

## Joins

| Símbolo | Descrição |
| --- | --- |
| `join(Model, alias)` | Inicia um `JoinBuilder<{ [alias]: Row }>`. |
| `.innerJoin(Model, alias, on)` | Inner join; adiciona `{ [alias]: Row }`. |
| `.leftJoin(Model, alias, on)` | Left join; adiciona `{ [alias]: Row \| null }`. |
| `.where(input)` | Filtra por refs `alias.column` tipadas. |
| `.orderBy(ref, dir?)` / `.limit(n)` / `.offset(n)` | Como no `select`. |

`on` mapeia refs de fontes existentes pra refs da nova tabela (igualdade):
`{ "user.id": "order.userId" }`. O resultado é um objeto por alias, coagido por
modelo; `leftJoin` produz `null` quando não há correspondência.

## Relations

| Símbolo | Faz |
| --- | --- |
| `hasMany(() => Target, { localKey, foreignKey })` | Relação 1-N. |
| `belongsTo(() => Target, { localKey, foreignKey })` | Relação N-1. |
| `loadRelations(session, rows, spec)` | Eager-load (1 query/relação); resultado tipado. |

`hasMany` → `Row[]`; `belongsTo` → `Row | null`.

## Migrações (`tempest-db-js/migrations`)

| Símbolo | Faz |
| --- | --- |
| `reflectSchema(models)` / `reflectTable(model)` | Modelo → Schema IR. |
| `diffSchema(atual, alvo)` | IR × IR → `Operation[]`. |
| `invert` / `invertAll` | Inverso de operações (pro `down()`). |
| `renderOperation(op, dialect)` | Operação → SQL. |
| `generateMigration(draft)` | Codegen de arquivo TS. |
| `topoOrder` / `heads` | Ordenação + pontas do DAG. |
| `MigrationRunner` / `Op` | Aplica/reverte; version table. |
| `replaySchema(migrations)` | IR "atual" sem banco. |
| `introspectSqlite` / `checkDrift` | Schema vivo + drift (SQLite). |
| `introspectPostgres` / `checkDriftPostgres` | Idem (PostgreSQL, estrutural). |
| `runMigrationCli(argv, config)` | CLI: `upgrade`/`downgrade`/`check`/`revision`... |
