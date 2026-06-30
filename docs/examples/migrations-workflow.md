# Fluxo de migrações

Como evoluir o schema de um projeto real do começo ao fim: gerar a primeira migração,
aplicar, mudar um modelo, gerar a próxima, e travar **drift** no CI — tudo sem escrever
um `.sql` solto. É o complemento prático do guia de [Migrações](../migrations.md).

!!! info "O princípio"

    Os **modelos** são a fonte da verdade. Você muda a classe; o tempest-db-js **calcula
    o diff** contra o estado atual e gera as operações tipadas. O SQL só nasce no
    renderer do dialeto, na hora de aplicar.

## 1. Estado inicial → primeira migração

Você tem os modelos e um banco vazio. `reflectSchema` lê as classes e `diffSchema`
compara com o vazio pra emitir as operações; `generateMigration` vira um arquivo TS:

```ts
import {
  reflectSchema, diffSchema, emptySchema, generateMigration,
} from "tempest-db-js/migrations";

const target = reflectSchema([User, Post]);          // IR dos modelos atuais
const ops = diffSchema(emptySchema(), target);        // [] → alvo  ⇒  create_table...

const src = generateMigration({
  revision: "0001_init",
  downRevision: [],
  label: "create users and posts",
  operations: ops,
});
// `src` é o conteúdo de um arquivo .ts editável, com up()/down() invertido.
```

Salve `src` em `migrations/0001_init.ts` e versione no git.

## 2. Aplicar

`MigrationRunner` renderiza as operações pro dialeto e executa, registrando o que já
rodou na tabela `tempest_db_js_migrations`:

```ts
import { NodeSqliteDriver } from "tempest-db-js";
import { MigrationRunner } from "tempest-db-js/migrations";
import { migrations } from "./migrations";  // suas migrações importadas em ordem

const driver = NodeSqliteDriver.open("app.db");
const runner = new MigrationRunner(driver, "sqlite");

runner.upgrade(migrations, new Date().toISOString()); // aplica as pendentes (ordem do DAG)
```

## 3. Evoluir o schema → próxima migração

Você adiciona um campo `published` ao `Post`. Em vez de escrever o `ALTER` na mão, deixe
o diff calcular — `replaySchema` reconstrói o estado "atual" a partir das migrações já
escritas, e você o compara com os modelos novos:

```ts
import { replaySchema, diffSchema, reflectSchema, generateMigration } from "tempest-db-js/migrations";

const current = replaySchema(migrations);            // estado segundo o histórico
const target = reflectSchema([User, Post]);          // modelos novos (com `published`)
const ops = diffSchema(current, target);             // ⇒ add_column published

const next = generateMigration({
  revision: "0002_post_published",
  downRevision: ["0001_init"],
  label: "add published to posts",
  operations: ops,
});
```

!!! tip "Ou via CLI"

    `runMigrationCli` faz isso por você, estilo Alembic:

    ```ts
    import { runMigrationCli } from "tempest-db-js/migrations";

    const config = { driver, dialect: "sqlite" as const, migrations, models: [User, Post] };
    runMigrationCli(["revision", "-m", "add published", "--autogenerate"], config);
    runMigrationCli(["upgrade"], config);          // aplica pendentes
    runMigrationCli(["upgrade", "--sql"], config); // só imprime o SQL (offline)
    runMigrationCli(["downgrade", "1"], config);   // reverte a última
    runMigrationCli(["history"], config);          // mostra o DAG
    ```

## 4. Reverter

```ts
runner.downgrade(migrations, 1); // desfaz a última revisão (usa o down() invertido)
```

Como cada operação tem um **inverso conhecido**, o `down()` é gerado automaticamente — um
`create_table` vira `drop_table`, um `add_column` vira `drop_column`, etc.

## 5. Gate de drift no CI

O pior cenário é o banco e os modelos divergirem silenciosamente. `checkDrift` lê o
schema **vivo** do banco e compara com os modelos — lista vazia = tudo certo:

```ts
import { checkDrift } from "tempest-db-js/migrations";

const issues = checkDrift(driver, [User, Post]);
if (issues.length > 0) {
  console.error("schema drift detectado:", issues);
  process.exit(1); // falha o pipeline
}
```

Coloque isso num passo de CI: se alguém mudou um modelo sem gerar a migração (ou aplicou
um SQL manual no banco), o build **quebra** antes de chegar em produção.

!!! check "Por que não 'costura de SQL'"

    Tudo flui por uma **Schema IR + operações tipadas**; o SQL só aparece no renderer do
    dialeto. Você nunca escreve nem versiona um `.sql` solto, o `down()` é derivado, e a
    mesma migração roda em SQLite e PostgreSQL com a DDL idiomática de cada um.

## Recap

- `reflectSchema` + `diffSchema` + `generateMigration` → primeira migração a partir dos modelos.
- `replaySchema` reconstrói o estado atual pra calcular o diff da **próxima** migração.
- `MigrationRunner.upgrade/downgrade` aplica/reverte de verdade, com version table e DAG.
- `runMigrationCli` dá os comandos estilo Alembic; `checkDrift` é seu gate de CI.
