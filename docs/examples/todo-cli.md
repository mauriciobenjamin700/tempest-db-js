# Todo CLI (SQLite)

Um gerenciador de tarefas de terminal, do zero ao funcionando. É o exemplo mais
didático: mostra o **loop completo** — criar a tabela, inserir, listar, concluir,
remover — em SQLite síncrono, sem nenhuma dependência além do tempest-db-js.

!!! info "O que você vai ver"

    - Um modelo com timestamp gerenciado.
    - Criação de tabela via migração pontual.
    - `insert ... returning`, `select` com filtro tipado, `update`/`del` com guard.

## 1. O modelo

```ts
import { Model, column, sql } from "tempest-db-js";

class Task extends Model {
  static tablename = "tasks";
  id = column.integer().primaryKey();
  title = column.text().notNull();
  done = column.boolean().notNull().default(false);
  createdAt = column.datetime().notNull().default(sql.now());
}
```

## 2. Banco + tabela

Usamos o padrão compartilhado da [galeria](index.md#o-padrao-compartilhado): um driver,
uma migração que cria a tabela, e uma sessão sobre o mesmo driver.

```ts
import { NodeSqliteDriver, SyncEngine } from "tempest-db-js";
import { MigrationRunner, reflectTable, type Migration } from "tempest-db-js/migrations";

const driver = NodeSqliteDriver.open("todo.db");

const init: Migration = {
  revision: "init",
  downRevision: [],
  up: (op) => op.createTable(reflectTable(Task)),
  down: (op) => op.dropTable(reflectTable(Task)),
};
new MigrationRunner(driver, "sqlite").upgrade([init], new Date().toISOString());

const session = new SyncEngine(driver).session();
```

## 3. As operações

Cada comando do CLI é uma função pequena. Repare que **nada é anotado à mão** — os tipos
vêm do modelo.

```ts
import { insert, select, update, del } from "tempest-db-js";

/** Adiciona uma tarefa e devolve a linha criada. */
function add(title: string) {
  const [task] = session
    .execute(insert(Task).values({ title }).returning())
    .all(); // returning() → TaskRow
  return task;
}

/** Lista tarefas, opcionalmente só as pendentes, mais novas primeiro. */
function list(onlyPending = false) {
  const base = onlyPending ? select(Task).where({ done: false }) : select(Task);
  return session.execute(base.orderBy("createdAt", "desc")).all(); // TaskRow[]
}

/** Marca uma tarefa como concluída. O .where() satisfaz o guard. */
function complete(id: number) {
  return session.execute(update(Task).set({ done: true }).where({ id })).rowsAffected();
}

/** Remove uma tarefa. */
function remove(id: number) {
  return session.execute(del(Task).where({ id })).rowsAffected();
}
```

!!! warning "O guard te protege"

    `update(Task).set({ done: true })` **sem** `.where()` não compila quando passado pro
    `execute` — é o guard contra atualizar a tabela inteira sem querer. Pra concluir
    *todas* as tarefas de propósito, seria `.unguarded()`. Veja
    [Inserir, atualizar, deletar](../tutorial/mutations.md#o-guard-tipado-contra-full-table-writes).

## 4. Ligando no `process.argv`

```ts
const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "add":
    console.log("criada:", add(rest.join(" ")));
    break;
  case "ls":
    for (const t of list(rest[0] === "--pending")) {
      console.log(`[${t.done ? "x" : " "}] #${t.id} ${t.title}`);
    }
    break;
  case "done":
    console.log(complete(Number(rest[0])) ? "concluída" : "não encontrada");
    break;
  case "rm":
    console.log(remove(Number(rest[0])) ? "removida" : "não encontrada");
    break;
  default:
    console.log("uso: todo <add|ls [--pending]|done <id>|rm <id>>");
}

session.close();
```

## Rodando

```bash
node todo.js add "escrever os docs"
node todo.js add "publicar no npm"
node todo.js ls
# [ ] #2 publicar no npm
# [ ] #1 escrever os docs
node todo.js done 1
node todo.js ls --pending
# [ ] #2 publicar no npm
```

## Recap

- O modelo carrega tipo **e** schema; a migração materializa a tabela.
- `insert(...).returning()` devolve a linha criada já tipada.
- O guard de `update`/`del` exige `.where()` — sem full-table write por acidente.
- Tudo síncrono via `node:sqlite` embutido — zero instalação.
