# Migrações

O Querium tem um sistema de migrações inspirado no **Alembic** (SQLAlchemy), e
**explicitamente diferente** da "costura de SQL" de outras ferramentas: tudo flui
por uma **Schema IR + operações tipadas**, e o SQL só nasce no renderer do dialeto.
Você nunca escreve nem versiona um `.sql` solto.

Importe de `querium/migrations`:

```ts
import {
  reflectSchema, diffSchema, generateMigration,
  MigrationRunner, type Migration,
} from "querium/migrations";
```

!!! info "Estado"

    O núcleo (reflect, diff, render, codegen, grafo DAG, runner) está pronto e roda
    de verdade contra SQLite (`node:sqlite`). Introspecção/drift e o batch-mode do
    SQLite pra `alter_column` são refinamentos seguintes — veja o
    [Roadmap](roadmap.md).

## 1. Do modelo ao IR

`reflectSchema` lê suas classes e produz a **IR** — a descrição canônica,
independente de dialeto, do schema:

```ts
const target = reflectSchema([User, Post]);
// { tables: { users: { columns: {...}, primaryKey: ["id"] }, posts: {...} } }
```

## 2. Diff → operações tipadas

`diffSchema(atual, alvo)` compara dois IR e emite **operações** — nunca SQL:

```ts
import { emptySchema } from "querium/migrations";

const ops = diffSchema(emptySchema(), target);
// [ { kind: "create_table", table: {...} }, { kind: "create_table", ... } ]
```

Cada operação tem um **inverso conhecido** (`invert`), o que dá `down()` automático.

## 3. Autogenerate → arquivo de migração

`generateMigration` transforma as operações num arquivo TS **editável**, com `up()`
e um `down()` invertido:

```ts
const src = generateMigration({
  revision: "a1b2c3",
  downRevision: [],
  label: "create users",
  operations: ops,
});
// string TS: export const up/down, operações embutidas como dados
```

## 4. Aplicar / reverter

`MigrationRunner` renderiza as operações pro dialeto e executa via driver,
rastreando revisões aplicadas na tabela `querium_migrations`:

```ts
import { NodeSqliteDriver } from "querium";

const driver = NodeSqliteDriver.open("app.db");
const runner = new MigrationRunner(driver, "sqlite");

runner.upgrade(migrations, new Date().toISOString()); // aplica pendentes (ordem do DAG)
runner.downgrade(migrations, 1);                       // reverte a última
```

Migração escrita à mão usa a fachada `Op`:

```ts
const migration: Migration = {
  revision: "m1",
  downRevision: [],
  up: (op) => op.createTable(reflectTable(User)),
  down: (op) => op.dropTable(reflectTable(User)),
};
```

## 5. Grafo de revisões (DAG)

`downRevision` é uma **lista de pais** — o histórico é um DAG, não uma corrente.
Suporta branches paralelas e merge. `topoOrder` ordena pra aplicar (pais antes de
filhos, determinístico); `heads` mostra as pontas:

```ts
import { topoOrder, heads } from "querium/migrations";

topoOrder(migrations); // ordem de aplicação
heads(migrations);      // revisões sem filhos (avisa se > 1)
```

## 6. Mudanças de coluna no SQLite (batch-mode)

O SQLite não faz `ALTER COLUMN`. O Querium resolve com **table-rebuild** (igual ao
batch mode do Alembic): a operação `recreate_table` cria uma tabela nova com o
schema-alvo, copia as colunas comuns, e troca os nomes — **preservando os dados**.
No PostgreSQL a mesma operação vira `ALTER/ADD/DROP` por coluna.

```ts
// numa migração:
up: (op) => op.recreateTable(reflectTable(UserOld), reflectTable(UserNew)),
```

## 7. Drift: o banco diverge dos modelos?

`introspectSqlite` lê o schema vivo do banco; `checkDrift` compara com os modelos e
devolve uma lista de divergências (vazia = sem drift). A comparação é no nível de
**afinidade** do SQLite, então `varchar` vs `TEXT` **não** é falso-positivo:

```ts
import { checkDrift } from "querium/migrations";

const issues = checkDrift(driver, [User, Post]);
if (issues.length > 0) {
  console.error("schema drift:", issues); // ótimo como gate de CI
}
```

## 8. CLI (programática)

`runMigrationCli(argv, config)` despacha comandos estilo Alembic e devolve linhas +
exit code (testável; um `bin` fino só liga em `process.argv`/`process.exit`):

```ts
import { runMigrationCli } from "querium/migrations";

const config = { driver, dialect: "sqlite" as const, migrations, models: [User, Post] };
runMigrationCli(["upgrade"], config);                       // aplica pendentes
runMigrationCli(["upgrade", "--sql"], config);              // imprime SQL (offline)
runMigrationCli(["downgrade", "1"], config);                // reverte
runMigrationCli(["current"], config);                       // revisões aplicadas
runMigrationCli(["history"], config);                       // DAG
runMigrationCli(["heads"], config);                         // pontas
runMigrationCli(["check"], config);                         // drift + diff (gate de CI)
runMigrationCli(["revision", "-m", "x", "--autogenerate"], config); // gera migração
```

`replaySchema(migrations)` reconstrói a IR "atual" sem banco — é o que o
`--autogenerate` compara com os modelos.

!!! note "PostgreSQL"

    `introspectPostgres`/`checkDriftPostgres` (via `information_schema`) e o **enum
    nomeado** (`CREATE TYPE ... AS ENUM`) existem mas não são exercitados no CI (sem
    Postgres no ambiente). `PoolOptions` repassa tuning ao `postgres.js`.

## Recap

- `reflectSchema(models)` → IR; `diffSchema(atual, alvo)` → operações tipadas.
- `generateMigration(...)` → arquivo TS editável com `up()`/`down()` invertido.
- `MigrationRunner.upgrade/downgrade` aplica/reverte de verdade, com version table.
- Grafo **DAG** (`topoOrder`/`heads`) suporta branch/merge.
- **SQL só no renderer do dialeto** — nunca um `.sql` solto.
