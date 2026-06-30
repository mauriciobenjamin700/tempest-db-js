# tempest-db-js

**tempest-db-js** é um ORM **type-safe** e **class-based** para TypeScript. Ele traz a
ergonomia do **SQLAlchemy 2.0** — modelos declarados como classes, schema como
fonte única da verdade — pro mundo JS/TS, com inferência de tipos forte do começo
ao fim: você define a tabela uma vez e o TypeScript sabe o formato de cada linha
em todo `select`, `insert`, `update` e `delete`.

É a camada de dados do futuro **`tempest-ts-sdk`**.

> :material-translate: **Idiomas / Languages** — esta documentação é bilíngue.
> Use o seletor de idioma no topo da página pra alternar entre
> **Português (BR)** e **English (US)**.

!!! success "Status: alpha (`v0.1.0`) — publicado no [npm](https://www.npmjs.com/package/tempest-db-js)"

    O caminho completo funciona de ponta a ponta: schema declarativo, query builder
    tipado, **execução real em SQLite** (testada contra `node:sqlite`), joins,
    relations, migrações estilo Alembic e um `BaseRepository` tipado. A superfície
    pública ainda pode mudar antes da `v1.0` — veja o [Roadmap](roadmap.md).

## Por que tempest-db-js?

Você define o modelo **uma vez**, como classe — e o tempest-db-js infere todo o resto:

```ts
import { Model, column, type InferModel, type InferInsert } from "tempest-db-js";

class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  age = column.integer().notNull();
  nickname = column.text();                  // anulável
  createdAt = column.timestamp().default(new Date());
}

type UserRow    = InferModel<typeof User>;
// { id: number; name: string; age: number; nickname: string | null; createdAt: Date | null }

type UserInsert = InferInsert<typeof User>;
// { name: string; age: number; nickname: string | null; id?: number; createdAt?: Date | null }
```

Sem `interface` manual, sem passo de codegen, sem schema e tipo divergindo. A
classe **é** a fonte da verdade — igual ao `Mapped[...]` declarativo do SQLAlchemy.

E a inferência se propaga pras queries:

```ts
import { select } from "tempest-db-js";

// O resultado é inferido como UserRow[] — sem anotação manual
const adults = select(User).where({ age: { gt: 18 } }).orderBy("age", "desc");

// Projeção infere Pick<UserRow, "id" | "name">[]
const names = select(User, ["id", "name"]);
```

## A realidade do TypeScript

O SQLAlchemy lê `Mapped[int]` em **runtime** via descriptors; o TypeScript **apaga
os tipos** na compilação. O tempest-db-js contorna isso fazendo cada coluna ser um
**builder com tipo em runtime** (`column.integer()`) que carrega ao mesmo tempo o
tipo SQL (runtime) e o tipo estático (inferência).

Você ganha a ergonomia de classes **e** inferência forte de resultado de query. O
trade-off: a linha retornada é um objeto plano inferido, não uma instância de
classe com métodos (active-record fica como objetivo pós-MVP). Detalhes em
[Arquitetura](architecture.md).

## Comece em 1 minuto

```bash
npm install tempest-db-js
```

SQLite não precisa de driver extra (usa o `node:sqlite` embutido do Node). Pra
PostgreSQL, `npm install postgres`.

```ts
import { Model, column, select, insert, createSyncEngine } from "tempest-db-js";

class Task extends Model {
  static tablename = "tasks";
  id = column.integer().primaryKey();
  title = column.text().notNull();
  done = column.boolean().notNull();
}

const engine = createSyncEngine("sqlite://:memory:");
const session = engine.session();

session.execute(insert(Task).values({ title: "escrever docs", done: false }));

const pending = session.execute(select(Task).where({ done: false })).all();
// `pending` é { id: number; title: string; done: boolean }[] — sem anotação manual
```

A execução é real e testada contra um banco SQLite de verdade (`node:sqlite`):
coerção de tipos, `RETURNING`, transações e rollback. PostgreSQL roda via `postgres.js`.

Novo por aqui? Siga o **[Tutorial — Comece aqui](tutorial/index.md)**: do primeiro
modelo a executar queries contra um banco, um conceito por página.

## O que tem dentro

| Área | Páginas |
| --- | --- |
| **Tutorial** | [Comece aqui](tutorial/index.md) · [Modelos](tutorial/models.md) · [Consultas](tutorial/queries.md) · [Inserir, atualizar, deletar](tutorial/mutations.md) · [Executando queries](tutorial/execution.md) · [Joins](tutorial/joins.md) |
| **Receitas** | [created_at/updated_at](recipes/timestamps.md) · [Paginação](recipes/pagination.md) · [Transações](recipes/transactions.md) · [JSON e enum](recipes/json-enum.md) |
| **Exemplos** | [Todo CLI](examples/todo-cli.md) · [Blog](examples/blog.md) · [REST API](examples/rest-api.md) · [Fluxo de migrações](examples/migrations-workflow.md) |
| **Guia** | [Arquitetura](architecture.md) · [Repository](repository.md) · [Migrações](migrations.md) · [Referência da API](reference.md) |
| **Projeto** | [Roadmap](roadmap.md) · [Contribuindo](contributing.md) · [Changelog](changelog.md) |

## Princípios

1. **Tipo é o produto.** Cada feature entrega testes de tipo, não só de runtime.
2. **Zero SQL por string.** Sempre parametrizado — injection-safe por construção.
3. **Class-first, mas honesto com o TS.** Abraçamos o que o TS faz bem.
4. **Docs seguem o código.** Bilíngue, estilo tutorial, no mesmo commit.
