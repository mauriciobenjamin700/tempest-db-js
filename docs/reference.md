# Referência da API

Superfície pública do tempest-db-js nas Fases 1 e 2. Tudo é importado do nível do pacote:

```ts
import {
  Model, column,
  type InferModel, type InferInsert,
  select, insert, update, del,
} from "tempest-db-js";
```

!!! note "Referência viva"

    Esta página cobre o que existe hoje (Fases 1-2). Conforme novas fases entram
    (execução, operadores tipados, joins, migrações), a referência cresce junto. A
    fonte da verdade são os docstrings no código.

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

O default fica guardado em `column.<campo>.defaultValue` / `.onUpdateValue` —
alimenta o IR de migração (Fase 6).

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
| `.node` | A AST `SelectNode` (read-only). |

### Operadores de `where` (`OperatorsFor<T>`)

Cada valor de `where` aceita um match exato (shorthand de `eq`) ou um objeto de
operador restrito ao tipo da coluna:

| Tipo | Operadores permitidos |
| --- | --- |
| `string` | `eq`, `ne`, `in`, `notIn`, `like`, `ilike`, `isNull` |
| `number` / `bigint` / `Date` | `eq`, `ne`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `between`, `isNull` |
| `boolean` | `eq`, `ne`, `isNull` |
| json / blob | `eq`, `ne`, `in`, `notIn`, `isNull` |

`OPERATORS` (runtime) e o tipo `Operator` listam o conjunto completo. Operador
inválido pro tipo = erro de compilação.

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
| `.returning()` | Resultado vira a linha completa. |
| `.returning(columns)` | Resultado vira `Pick` das colunas. |

Sem `returning`, o resultado da execução é `number` (linhas afetadas).

## UPDATE

### `update(Model)`

Retorna `UpdateBuilder<Full, false>` (não-guarded).

| Método | Descrição |
| --- | --- |
| `.set(values)` | `Partial<Full>` — só as colunas informadas mudam. |
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

Expostos pra ferramentas e dialetos (Fase 4): `SelectNode`, `InsertNode`,
`UpdateNode`, `DeleteNode`, `OrderTerm`, `SortDirection`, `WhereInput`, `Returning`.

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
(injection-safe por construção). Não executa — execução é a Fase 4b.

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

Diferenças por dialeto: placeholder (`?` vs `$1`) e `ilike` (nativo `ILIKE` no
Postgres; `LIKE` no SQLite, case-insensitive em ASCII).

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
