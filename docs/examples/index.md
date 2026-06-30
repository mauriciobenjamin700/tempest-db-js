# Galeria de exemplos

Enquanto as [Receitas](../recipes/index.md) resolvem um problema isolado, os **exemplos**
são **projetinhos completos que rodam** — do `CREATE TABLE` à última query — pra você ver
as peças encaixadas. Cada um é copy-paste e auto-contido.

## Os projetos

<div class="grid cards" markdown>

- :material-console: **[Todo CLI (SQLite)](todo-cli.md)**

    Um gerenciador de tarefas de terminal. Cria a tabela via migração, insere, lista e
    conclui — o **loop completo** em SQLite síncrono. Comece por aqui.

- :material-post: **[Blog (relations + joins)](blog.md)**

    `users` → `posts` → `comments`. Mostra `hasMany`/`belongsTo` + `loadRelations`
    (sem N+1) e joins compostos tipados. O exemplo de **modelagem relacional**.

- :material-api: **[REST API (Hono + Repository)](rest-api.md)**

    Endpoints HTTP backed por `BaseRepository`, com paginação tipada e convenção 404.
    A ponte com o mundo `tempest-fastapi-sdk` / `tempest-ts-sdk`.

- :material-database-sync: **[Fluxo de migrações](migrations-workflow.md)**

    O ciclo de vida do schema: `autogenerate`, `upgrade`/`downgrade` e um **gate de
    drift no CI**. Como evoluir o banco sem escrever SQL solto.

</div>

## O padrão compartilhado

Todos os exemplos SQLite usam o mesmo esqueleto pra ter uma tabela pronta: um driver
único, uma migração pontual que cria as tabelas, e uma sessão sobre **o mesmo driver**.

```ts
import { NodeSqliteDriver, SyncEngine } from "tempest-db-js";
import { MigrationRunner, reflectTable, type Migration } from "tempest-db-js/migrations";

const driver = NodeSqliteDriver.open(":memory:");   // um banco em memória

const init: Migration = {
  revision: "init",
  downRevision: [],
  up: (op) => op.createTable(reflectTable(MyModel)),
  down: (op) => op.dropTable(reflectTable(MyModel)),
};
new MigrationRunner(driver, "sqlite").upgrade([init], new Date().toISOString());

const session = new SyncEngine(driver).session();   // sessão sobre o MESMO driver
```

!!! tip "Por que o mesmo driver?"

    Um `:memory:` pertence à conexão que o abriu. Reusar o **mesmo `driver`** entre o
    `MigrationRunner` e o `SyncEngine` garante que a sessão veja as tabelas que a
    migração criou. Pra um banco em arquivo (`sqlite:///app.db`), conexões diferentes
    também enxergam o mesmo schema.
