# Modelos

Toda tabela no Querium é uma **classe** que estende `Model`. Os campos da classe
são **colunas**, criadas pela fábrica `column`. Vamos modelar nossa primeira
tabela: usuários.

## Passo 1 — Declare a tabela

```ts
import { Model, column } from "querium";

class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  age = column.integer().notNull();
  nickname = column.text();                  // sem .notNull() → anulável
  createdAt = column.timestamp().default(new Date());
}
```

Três coisas a notar:

1. **`static tablename`** define o nome da tabela no banco. É `static` porque
   pertence à tabela, não a uma linha.
2. **Cada coluna é um valor**, atribuído a um campo (`id = column.integer()`). Esse
   valor carrega tanto o tipo SQL (runtime) quanto o tipo estático (inferência).
3. **Modificadores encadeiam**: `.primaryKey()`, `.notNull()`, `.default(...)`.

!!! info "Por que `column.integer()` e não `id: number`?"

    O TypeScript apaga os tipos na compilação — `id: number` não existiria em
    runtime, então o Querium não teria como saber que `id` é uma coluna `INTEGER`.
    Fazendo a coluna ser um **valor** (`column.integer()`), a informação sobrevive
    em runtime **e** o tipo estático é inferido a partir dela. É o truque central
    do Querium. Veja [Arquitetura](../architecture.md) pra fundo.

## Passo 2 — Os tipos de coluna

A fábrica `column` cobre um catálogo rico de tipos, espelhando os tipos genéricos
do SQLAlchemy. Cada um é um **tipo SQL distinto** mapeado pro tipo TS certo:

| Builder | Tipo TS | Tipo SQL |
| --- | --- | --- |
| `column.smallInteger()` | `number` | `SMALLINT` |
| `column.integer()` | `number` | `INTEGER` |
| `column.bigInteger()` | `bigint` | `BIGINT` |
| `column.numeric(p, s)` / `column.decimal(p, s)` | `string` | `NUMERIC(p,s)` |
| `column.real()` | `number` | `REAL` |
| `column.double()` | `number` | `DOUBLE PRECISION` |
| `column.varchar(n)` / `column.string(n)` | `string` | `VARCHAR(n)` |
| `column.char(n)` | `string` | `CHAR(n)` |
| `column.text()` | `string` | `TEXT` |
| `column.boolean()` | `boolean` | `BOOLEAN` |
| `column.date()` | `Date` | `DATE` |
| `column.time({ timezone })` | `string` | `TIME` |
| `column.datetime({ timezone })` | `Date` | `DATETIME`/`TIMESTAMP` |
| `column.timestamp({ timezone })` | `Date` | `TIMESTAMP` |
| `column.blob()` | `Uint8Array` | `BLOB`/`BYTEA` |
| `column.json<T>()` | `T` | `JSON` |
| `column.jsonb<T>()` | `T` | `JSONB` |
| `column.uuid()` | `string` | `UUID` |
| `column.enum(...vals)` | união literal | `ENUM` |

!!! tip "`varchar` ≠ `text`, e por que `bigint`/`numeric` são especiais"

    - `varchar(n)` é limitado (`VARCHAR(n)`); `text` é ilimitado (`TEXT`) — tipos SQL
      distintos, como no SQLAlchemy.
    - `bigInteger` mapeia pra **`bigint`** (não `number`) pra preservar 64 bits sem
      perder precisão.
    - `numeric`/`decimal` mapeiam pra **`string`** — o JS não tem decimal exato, e
      stringificar preserva a precisão em vez de jogá-la num float.
    - `enum("admin", "user")` infere a **união literal** `"admin" | "user"`.

E os modificadores que mudam a **forma inferida** ou o comportamento:

| Modificador | Efeito |
| --- | --- |
| `.primaryKey()` | Marca como chave primária (e implica default). |
| `.notNull()` | Coluna não-anulável → o tipo perde o `| null`. |
| `.default(v)` | Default no insert → opcional no insert. Aceita valor ou expressão de {@link sql}. |
| `.onUpdate(v)` | Reaplica o valor a cada UPDATE (ex.: `updated_at`). |

### Defaults portáveis (`sql`)

Além de valores constantes, `.default()` aceita **expressões portáveis** do namespace
`sql` — o dialeto renderiza a SQL certa (`CURRENT_TIMESTAMP` no SQLite, `now()` no
Postgres). É o equivalente do `func.now()`/`server_default` do SQLAlchemy.

```ts
import { Model, column, sql } from "querium";

class Post extends Model {
  static tablename = "posts";
  id = column.uuid().primaryKey().default(sql.uuidv4());     // gera UUID no banco
  title = column.varchar(120).notNull();
  views = column.integer().notNull().default(0);             // literal
  createdAt = column.datetime().notNull().default(sql.now());           // preenchido no insert
  updatedAt = column.datetime().notNull().default(sql.now()).onUpdate(sql.now()); // e a cada update
}
```

Expressões disponíveis: `sql.now()`, `sql.currentDate()`, `sql.currentTime()`,
`sql.uuidv4()` e `sql.raw("...")` (escape hatch). O default fica **guardado na
coluna** (`column.createdAt.defaultValue`) — é o que alimenta o IR de migração na
Fase 6.

## Passo 3 — Infira o tipo de linha (SELECT)

Aqui está o pagamento. Use `InferModel` pra extrair o formato de uma **linha lida**:

```ts
import { type InferModel } from "querium";

type UserRow = InferModel<typeof User>;
// {
//   id: number;
//   name: string;
//   age: number;
//   nickname: string | null;   // anulável → vira `| null`
//   createdAt: Date | null;
// }
```

Repare na nullability: `name` e `age` têm `.notNull()`, então são `string`/`number`.
`nickname` e `createdAt` não — então o Querium infere `| null`, igual à semântica do
SQL (uma coluna sem `NOT NULL` pode conter `NULL`).

!!! check "Sem repetição"

    Você não escreveu nenhuma `interface User` à mão. O tipo `UserRow` **deriva**
    da classe. Mude uma coluna e o tipo muda junto — schema e tipo nunca divergem.

## Passo 4 — Infira o tipo de inserção (INSERT)

Inserir é diferente de ler: colunas com **default** (ou chave primária) são
opcionais, porque o banco preenche. Use `InferInsert`:

```ts
import { type InferInsert } from "querium";

type UserInsert = InferInsert<typeof User>;
// {
//   name: string;             // obrigatório
//   age: number;              // obrigatório
//   nickname: string | null;  // obrigatório (anulável, mas sem default)
//   id?: number;              // opcional (PK)
//   createdAt?: Date | null;  // opcional (tem default)
// }
```

`id` e `createdAt` viraram opcionais (`?`); o resto continua obrigatório. Você não
precisa passar uma PK auto-incremento nem o timestamp com default ao criar um
usuário.

## Recap

- Tabela = classe `extends Model` com `static tablename`.
- Coluna = **valor** criado por `column.*()`, com modificadores encadeáveis.
- `.notNull()` controla a nullability do tipo inferido.
- `InferModel<typeof T>` → forma de linha pra **leitura**.
- `InferInsert<typeof T>` → forma pra **inserção** (PK/default opcionais).

Com o modelo no lugar, vamos consultá-lo. 👉 **[Consultas](queries.md)**
