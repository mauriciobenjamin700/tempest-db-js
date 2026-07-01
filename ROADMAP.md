# tempest-db-js — Roadmap

> ORM type-safe e class-based para TypeScript. Ergonomia do **SQLAlchemy 2.0** trazida pro mundo JS/TS.
> Pacote npm base do futuro **`tempest-ts-sdk`**.

## Decisões de arquitetura (travadas)

| Decisão | Escolha | Motivo |
|---|---|---|
| Definição de schema | **Class-based** (herança de `Model`, `static tablename`) | Espelhar SQLAlchemy declarativo. |
| Captura de tipo | **Column-builders como campos** (`id = column.integer()`) | TS apaga tipos em runtime — o builder carrega runtime-type + tipo estático. Inferência de query forte. |
| Linha retornada | Objeto plano inferido (`InferModel`) | Active-record com métodos na instância = stretch goal. |
| Bancos (foco em 3, nessa ordem) | **1. SQLite** (`node:sqlite`/`better-sqlite3`) → **2. PostgreSQL** (`postgres.js`) → **3. MySQL** | Escopo fechado nesses 3, sem outros por ora. SQLite/Postgres espelham dev/prod dos serviços Python; MySQL entra depois do fluxo SQLite+Postgres fechar. |
| Runtime | Node ≥ 20 | Bun/Deno/browser depois. |
| Async | API `async` por padrão; SQLite sync por baixo, exposto via Promise | Consistência com o ecossistema. |

### A restrição central do TS

SQLAlchemy lê `Mapped[int]` em runtime (`get_type_hints` + descriptors). TS **não pode** — tipos somem na compilação. Por isso a coluna é um **valor runtime tipado**:

```ts
class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();   // runtime: IntegerColumn | type: Mapped<number>
  name = column.text();
  age = column.integer();
}
type UserRow = InferModel<typeof User>; // { id: number; name: string; age: number }
```

`User.id` (acesso de classe) → referência de coluna pra queries. Linha retornada → `UserRow` plano. Não tentamos fazer um campo ser `Mapped<number>` e `number` ao mesmo tempo (descriptor do SQLAlchemy é inimitável em TS sem proxy custoso).

---

## Fase 0 — Fundação (semana 1)

Toolchain, build, CI. Sem feature ainda.

- `tsup` (build dual ESM+CJS + `.d.ts`), `vitest`, `biome`, `tsc --noEmit` como gate de tipos.
- **Type-level tests** desde já (`expectTypeOf` do vitest). Num ORM tipado, teste de tipo é teste de produto.
- CI: lint + test + test:types em cada push.
- Docs bilíngues MkDocs-Material (PT-BR default + EN) — padrão de todo pacote publicado. Setup cedo, conteúdo evolui por fase.

**Entrega:** `npm run build/test/test:types` verdes, CI rodando.

---

## Fase 1 — Schema declarativo class-based + inferência ⭐ (semanas 2-3)

O coração. Tudo deriva daqui.

- `Model` base + `column` builders: `integer`, `text`, `boolean`, `real`, `blob`, `timestamp`, `json`, `uuid`.
- Modificadores encadeáveis: `.primaryKey()`, `.notNull()`, `.default(v)`, `.unique()`, `.references(() => Other.col)`.
- Cada builder carrega: tipo SQL (runtime) + `_type` fantasma (estático) + flags de nullability/default que afetam o tipo inferido.
- `InferModel<typeof Model>` → shape de linha (PK/default viram opcionais no insert, presentes no select).
- Registro de metadata: construtor da base lê `Object.entries(this)` → nome de coluna = chave do campo.

```ts
class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  age = column.integer().notNull();
  createdAt = column.timestamp().default("now()");
}

type UserRow    = InferModel<typeof User>;        // select shape
type UserInsert = InferInsert<typeof User>;       // id/createdAt opcionais
```

**Entrega:** definir tabela, extrair `UserRow`/`UserInsert`, metadata introspectável. Type-tests cobrindo nullability + defaults.

**Decidido (spike compilado):** **campos-builder puros** (`id = column.integer()`), sem `reflect-metadata`. Inferência mais forte e já provada por `tsc`. Sem decorators.

---

## Fase 2 — Query builder tipado: SELECT/INSERT/UPDATE/DELETE (semanas 3-4)

**Design travado (spike compilado em `src/query.ts`):**

- **Builder = AST + tipos fantasma, zero execução.** Compila pra SQL e roda só na Fase 4 (`session.execute`). Entrega type-safety pura, testável só com `tsc`.
- **Dois parâmetros de tipo:** `SelectBuilder<Full, Proj>`. `Full` = linha completa (tipa chaves de `where`/`orderBy`); `Proj` = projeção retornada. Sem projeção, `Proj = Full`.
- **Projeção infere `Pick`:** `select(User, ["id","name"])` → `Pick<UserRow,"id"|"name">`. Sobrevive ao encadeamento (`.where().orderBy().limit()`).
- **Imutável/encadeável:** cada método retorna novo builder; AST acumula. Bom pra reuso e debug.
- **`where` tipa chaves agora**, valores/operadores ficam abertos até a Fase 3. Chave fora do schema = erro de compilação (provado por `@ts-expect-error`).
- **`insert(User).values(...)`** tipado por `UserInsert`; `update`/`delete` exigem `where` por convenção (guard contra wipe acidental — flag explícita libera full-table).
- **Terminais (`.all/.first/.one/.scalar`)** moram no resultado de `session.execute` (Fase 4) — o tipo de retorno já vem fixado no builder.

**Entrega:** ✅ **Completa.** SELECT (projeção + `where`/`orderBy`/`limit`/`offset`), INSERT (`values` tipado por `InferInsert`, `.returning()`), UPDATE/DELETE com **guard de estado tipado** (`Guarded extends boolean` — só vira executável após `.where()` ou `.unguarded()` explícito) e `.returning(cols)` inferindo `Pick`. 19 type-tests, incl. negativos.

---

## Fase 3 — Operadores tipados por tipo de coluna (semana 5)

Operador só compila se o tipo da coluna permite.

- Numéricos (`integer`/`real`): `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `between`, `isNull`.
- Texto: `eq`, `ne`, `like`, `ilike`, `in`, `isNull`.
- Boolean: `eq`, `ne`, `isNull`.
- Combinadores: `and(...)`, `or(...)`, `not(...)`.

```ts
select(User).where({
  age:  { gt: 18 },          // ✅
  name: { like: "%Ben%" },   // ✅
  // age: { like: "%x%" }    // ❌ erro de compilação — like não existe em number
});
```

**Entrega:** ✅ **Completa.** `OperatorsFor<T>` restringe operadores por tipo de
coluna (string→`like`/`ilike`; number/bigint/Date→ordenados+`between`;
boolean→eq/isNull). `WhereInput` aplica isso por coluna, com shorthand de valor
bare. 9 type-tests, incl. negativos (`like` em number, `gt` em string, `between` em
boolean, enum inválido, eq de tipo errado).

> ✅ **Combinadores `and`/`or`/`not` feitos** — árvore `Condition` unificada em
> select/update/delete/join; compilador recursivo (`(...) OR (...)`, `NOT (...)`).
> A forma objeto segue como AND implícito.

---

## Fase 4 — Dialetos + execução real (Session) (semanas 6-7)

> **Design detalhado em [`SESSION_DESIGN.md`](SESSION_DESIGN.md).** Modelo
> Engine/Session/Pool/Transação do SQLAlchemy 2.0. **Async por padrão, sync
> opcional** (SQLite); Postgres é async-only.

Onde o AST vira SQL e roda. **Maior fatia de performance.**

- Banco identificado **via URL** (`parseDatabaseUrl`, **já implementado**):
  `createEngine("postgresql://...")` (async) / `createSyncEngine("sqlite:///app.db")`.
- ✅ **4a feito:** `Dialect.compile(node)` → `{ sql, params }`. Impl: `SqliteDialect`,
  `PostgresDialect` (via `getDialect`). Compila SELECT/INSERT/UPDATE/DELETE, WHERE com
  todos os operadores, `RETURNING`. Sempre parametrizado (`?`/`$1`) — **nunca**
  interpolação (SQL injection). 12 runtime-tests. Falta 4b-4e (engine/Session/exec).
- `Engine` segura o **pool**; `Session` é a unit-of-work. `execute(query)` infere o
  retorno do builder. Terminais: `.all()`/`.first()`/`.one()`/`.oneOrNull()`/
  `.scalar()`/`.scalars()`.
- **Guard de estado** das mutações entra aqui: `execute` aceita só `update`/`del`
  com `Guarded = true`.
- Transações: `engine.transaction(async (tx) => {...})` com commit/rollback
  automático; `beginNested` (savepoints); `await using` (asyncDispose).
- `mapRow` reusa a coerção por `ColumnType` de `src/serialize.ts` (**já implementado**).

```ts
const engine = createEngine("sqlite:///app.db");          // dialeto detectado da URL
const session = engine.session();

const adults = await session.execute(select(User).where({ age: { gt: 18 } })).all();   // UserRow[]
const user   = await session.execute(select(User).where({ id: 1 })).first();           // UserRow | null
```

**Entrega:** ✅ **4a + 4b feitos.** 4b: `createEngine` (async, default) / `createSyncEngine`
(SQLite, sync); `Session.execute` infere o retorno do builder; terminais
`.all/.first/.one/.oneOrNull/.scalar/.scalars/.rowsAffected`; `engine.transaction`
(commit/rollback) + `beginNested` (savepoints); coerção de linha por tipo. SQLite
roda de verdade via `node:sqlite` (zero install nos testes); Postgres via `postgres.js`
(lazy). 23 runtime-tests. ✅ **`.stream()`** (sync/async, iteração preguiçosa) e
**`PoolOptions`** (passthrough postgres.js) feitos. ✅ **`using`/`await using`**
(`Symbol.dispose`/`asyncDispose` em Session/Engine) e ✅ **benchmark vs Drizzle/Kysely**
(`npm run bench` + [`BENCHMARKS.md`](BENCHMARKS.md)) feitos.

---

## Fase 5 — Joins + tipos compostos + relations (semanas 8-9)

- `.join(Order, on)` / `leftJoin` / `innerJoin` → retorno composto `{ user: UserRow; order: OrderRow }[]`.
- `on` type-checked contra colunas das tabelas envolvidas.
- `leftJoin` torna o lado direito `| null` no tipo (semântica SQL correta).
- Relations declarativas opcionais (`hasMany`/`belongsTo`) pra eager-load tipado.

```ts
const rows = await session.execute(
  select(User)
    .innerJoin(Order, eq(User.id, Order.userId))
    .where({ "order.status": "paid" })
).all();
// rows: { user: UserRow; order: OrderRow }[]
```

**Entrega:** ✅ **Completa (MVP).** `join(Model, alias)` + `.innerJoin`/`.leftJoin(Model,
alias, on)` → tipo composto `{ [alias]: Row }`; `leftJoin` torna o lado nullable.
`on`/`where`/`orderBy` usam refs `alias.column` tipadas (template-literal). Dialeto
compila com aliasing (`"a"."c" AS "a.c"`); execução faz split da linha plana em
composto, coagindo cada source. 12 testes (type + execução real, incl. leftJoin null).
✅ **Relations feitas** (`hasMany`/`belongsTo` + `loadRelations`, eager-load tipado
sem N+1) e **combinadores `and`/`or`/`not`** (também no join). ✅ **Operadores
tipados-por-coluna no `where` de join** feitos (`OperatorsFor<T>` por ref
`alias.column`; `like` em number / `gt` em string = erro de compilação).

---

## Fase 6 — Migrações + CLI (semanas 10-11)

> **Design detalhado em [`MIGRATIONS_DESIGN.md`](MIGRATIONS_DESIGN.md).** Inspirado
> no Alembic; explicitamente **não** é a "costura de SQL" do drizzle-kit.

Decisões travadas: migração = **script TS com `up()`/`down()`** chamando uma API de
**operações tipadas** (nunca SQL string); fonte do estado atual = **híbrido**
(replay das migrações → IR virtual pro diff + introspecção só pra drift); grafo de
revisões = **DAG** (`down_revision` é lista → branch/merge); `down()` **autogerado e
editável** (op irreversível lança erro, sem rollback silencioso quebrado).

Núcleo anti-Drizzle: **tudo flui por uma Schema IR + operações tipadas; SQL só nasce
no renderer do dialeto** (SQLite ganha batch-mode pro ALTER fraco). O `ColumnType`
rico (`varchar`/`text`/`uuid`/`json`/`enum`...) já implementado na base alimenta o IR.

CLI espelhando Alembic: `revision --autogenerate`, `upgrade`/`downgrade`, `current`,
`history`, `heads`, `merge`, `stamp`, `check` (gate de CI), `--sql` (offline).

**Entrega:** ✅ **Núcleo (6a-6c) feito** (`tempest-db-js/migrations`): `reflectSchema` (model→IR),
`diffSchema` (IR×IR→ops), operações tipadas + `invert`, `renderOperation` (DDL por
dialeto), `generateMigration` (codegen TS com `up`/`down` invertido), grafo **DAG**
(`topoOrder`/`heads`/ciclo), `MigrationRunner` (`Op` facade + version table +
`upgrade`/`downgrade` reais via `node:sqlite`). 13 testes, incl. migração real (cria
tabela → insere → downgrade derruba). ✅ **6d parcial**: `introspectSqlite` + `checkDrift`
(SQLite). ✅ **6e parcial**: batch-mode SQLite via `recreate_table` (table-rebuild
preservando dados); **enum nomeado PG** (`CREATE TYPE`). ✅ **CLI** (`runMigrationCli`:
`upgrade`/`downgrade`/`current`/`history`/`heads`/`check`/`revision --autogenerate`,
`--sql`) + `replaySchema`. ✅ **introspecção/drift Postgres** (`introspectPostgres`/
`checkDriftPostgres`, estrutural — sem PG no CI). ✅ **rename interativo**
(`detectRenames`/`applyRenames`; CLI `--autorename`/`--rename-table`/`--rename-column`;
prompt por candidato no bin quando TTY) e ✅ **bin executável** (`tempest-db`, carrega
`tempest-db.config.{mjs,js,cjs}`) feitos.

---

## Fase 7 — Integração `tempest-ts-sdk` + comunidade (semana 12+)

- `BaseRepository<Model>` espelhando o do `tempest-fastapi-sdk` (CRUD + paginação tipada).
- Schemas de paginação (`BasePaginationSchema<T>`) alinhados ao SDK Python.
- Docs estilo FastAPI/tiangolo: tutorial progressivo, exemplos completos rodáveis, admonitions, bilíngue, deploy GitHub Pages.
- Receitas: integração com servidores HTTP (Express/Hono/Fastify), padrão repository, transações.

**Entrega:** ✅ **`BaseRepository<Model>` feito**: `list`/`first`/`getById`/`getByIdOrNull`/
`exists`/`count`/`create`/`createMany`/`update`/`delete`/`paginate`, tipado por
`InferModel`/`InferInsert`/`WhereInput`, sobre `AsyncSession`. Convenção 404 honrada
(`getById` lança `RecordNotFound`; coleções retornam `[]`). `PaginationFilter`/
`PaginationResult` espelham `BasePagination*` do SDK Python. 7 testes reais (CRUD +
paginação asc/desc). ✅ **Receitas HTTP** feitas (Hono, **Express**, **Fastify** —
bilíngues) e ✅ **deploy do site de docs** (workflow `docs.yml` → GitHub Pages,
`mkdocs build --strict`). Falta: o pacote `tempest-ts-sdk` em si (repo próprio,
consumindo tempest-db-js).

---

## Linha do tempo

| Período | Fase | Marco |
|---|---|---|
| Sem 1     | 0 | Toolchain + CI + type-tests |
| Sem 2-3   | 1 | **Schema class-based + inferência** ⭐ |
| Sem 3-4   | 2 | Query builder (AST tipada) |
| Sem 5     | 3 | Operadores tipados |
| Sem 6-7   | 4 | Dialetos + Session (execução real) |
| Sem 8-9   | 5 | Joins + relations |
| Sem 10-11 | 6 | Migrações + CLI |
| Sem 12+   | 7 | Integração SDK + docs + comunidade |

## Princípios

1. **Tipo é o produto.** Toda fase entrega type-tests, não só runtime-tests.
2. **Zero SQL por string.** Sempre parametrizado.
3. **Performance mensurável.** Benchmark vs Drizzle/Kysely a partir da Fase 4.
4. **Class-first, mas honesto com TS.** Não imitamos descriptors do Python; abraçamos o que TS faz bem.
5. **Docs seguem o código.** Padrão tiangolo, bilíngue, no mesmo commit.

## Riscos / questões abertas

- **Inferência de operador por coluna** (Fase 3) é a parte mais pesada de type-gymnastics — pode exigir branded types e prototipagem cedo.
- **Active-record real** (métodos na instância de linha) fica fora do MVP — reavaliar pós-Fase 5.
- **Decorators**: decidir campos-puros vs `@table/@column` no spike da Fase 1.
- **Performance do mapeamento linha→objeto** em result sets grandes — medir cedo na Fase 4.
