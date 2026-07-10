# Chaves estrangeiras, UNIQUE e constraints de tabela

**Problema:** um schema real não é só "colunas com tipos". Ele tem **regras de
integridade**: um e-mail não pode repetir, um `post.author_id` tem que apontar pra um
`user` que existe, um par `(user_id, org_id)` só pode aparecer uma vez. Sem isso, o banco
aceita lixo.

**Solução:** declare essas regras **no modelo**, do mesmo jeito que o SQLAlchemy 2.0 faz —
e o tempest-db-js renderiza a DDL certa (`UNIQUE`, `REFERENCES ... ON DELETE`,
`CONSTRAINT ...`) pra SQLite, PostgreSQL e MySQL, além de detectá-las em *drift*.

## A teoria em uma frase

- `.unique()` → `UNIQUE` naquela coluna (espelha `mapped_column(unique=True)`).
- `.references("tabela.coluna", { onDelete })` → chave estrangeira (espelha
  `mapped_column(ForeignKey("tabela.coluna", ondelete=...))`).
- `static tableArgs = () => [...]` → constraints de **tabela** (compostas / nomeadas),
  espelhando o `__table_args__`.

!!! tip "Nada disso muda o tipo inferido"

    `.unique()` e `.references()` são **metadados de DDL**. Uma coluna `notNull` continua
    não-nula; uma coluna anulável continua anulável. `InferModel`/`InferInsert` não mudam.

## Passo 1 — UNIQUE por coluna

O caso mais comum: um campo que não pode repetir.

```ts
import { Model, column } from "tempest-db-js";

class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
  email = column.varchar(120).notNull().unique(); // ← não repete
}
```

Isso gera, no `CREATE TABLE`:

```sql
"email" VARCHAR(120) NOT NULL UNIQUE
```

## Passo 2 — Chave estrangeira por coluna

Aponte uma coluna pra chave de outra tabela. A referência é uma string
`"tabela.coluna"` — igualzinho ao `ForeignKey("users.id")` do SQLAlchemy.

```ts hl_lines="5"
class Post extends Model {
  static tablename = "posts";
  id = column.integer().primaryKey();
  title = column.text().notNull();
  authorId = column.integer().notNull().references("users.id", { onDelete: "cascade" });
}
```

Gera uma FK inline:

```sql
"authorId" INTEGER NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE
```

As ações disponíveis (`onDelete` / `onUpdate`) são as do SQL padrão:

| Token             | Renderiza como  |
| ----------------- | --------------- |
| `"cascade"`       | `CASCADE`       |
| `"restrict"`      | `RESTRICT`      |
| `"set null"`      | `SET NULL`      |
| `"set default"`   | `SET DEFAULT`   |
| `"no action"`     | `NO ACTION`     |

!!! warning "SQLite não força FK por padrão"

    O SQLite só honra chaves estrangeiras com `PRAGMA foreign_keys = ON`. O runner de
    migração já liga isso durante o rebuild de tabela; pra enforcement em runtime, ligue
    no seu driver ao abrir a conexão.

## Passo 3 — Constraints de tabela (composto / nomeado)

Quando a regra envolve **mais de uma coluna** — um UNIQUE composto ou uma FK composta —
use `static tableArgs`. Ele retorna uma lista de helpers, resolvida de forma preguiçosa
(por isso é um thunk `() => [...]`), o que permite referências pra frente.

```ts
import { Model, column, unique, foreignKey } from "tempest-db-js";

class Membership extends Model {
  static tablename = "memberships";
  userId = column.integer().notNull();
  orgId = column.integer().notNull();
  role = column.varchar(20).notNull();

  static tableArgs = () => [
    unique("userId", "orgId"),                                  // par único
    foreignKey(["userId"], "users", ["id"], { onDelete: "cascade" }),
  ];
}
```

Gera cláusulas nomeadas de tabela:

```sql
CONSTRAINT "uq_memberships_userId_orgId" UNIQUE ("userId", "orgId"),
CONSTRAINT "fk_memberships_userId" FOREIGN KEY ("userId")
  REFERENCES "users" ("id") ON DELETE CASCADE
```

!!! info "Nomes determinísticos"

    Se você não passar um `name`, o tempest-db-js gera um estável — `uq_<tabela>_<colunas>`
    e `fk_<tabela>_<colunas>`. Nome estável importa: é ele que o diff usa pra saber se um
    constraint foi **adicionado**, **removido** ou **alterado** entre uma migração e outra.

## Migrações

Como tudo vira IR, o diff sabe emitir operações **reversíveis** quando um constraint muda:

```ts
import { diffSchema, reflectSchema } from "tempest-db-js/migrations";

const ops = diffSchema(reflectSchema([MembershipV1]), reflectSchema([MembershipV2]));
// → [{ kind: "add_constraint", ... }] ou [{ kind: "drop_constraint", ... }]
```

- **PostgreSQL / MySQL:** viram `ALTER TABLE ... ADD CONSTRAINT` / `DROP CONSTRAINT`
  (no MySQL, `DROP INDEX` / `DROP FOREIGN KEY`).
- **SQLite:** não suporta `ALTER` de constraint — o diff direciona pra um *rebuild* de
  tabela (`recreate_table`), o mesmo caminho que o SQLite usa pra qualquer mudança que não
  seja um `ADD COLUMN`.

## Drift

O `checkDrift` compara o modelo contra o banco vivo e enxerga FK/UNIQUE de forma
**normalizada** — não importa se você declarou por coluna ou por `tableArgs`, ele compara
pelas colunas/tabela-alvo:

```ts
import { checkDrift, NodeSqliteDriver } from "tempest-db-js";

const issues = checkDrift(driver, [User, Post, Membership]);
// [] = sem drift; senão, mensagens do tipo:
// 'foreign key "posts: authorId=>users(id)" is missing from the database'
```

## Recap

- `.unique()` e `.references("tabela.coluna", { onDelete })` cobrem o caso por coluna.
- `static tableArgs = () => [unique(...), foreignKey(...)]` cobre composto/nomeado.
- Nenhum deles muda o tipo inferido — são metadados de DDL.
- O mesmo modelo dirige `CREATE TABLE`, `ALTER`/rebuild em migração e detecção de drift —
  uma fonte da verdade só, nos três dialetos.
