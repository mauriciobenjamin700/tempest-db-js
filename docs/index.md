# Querium

**Querium** é um ORM **type-safe** e **class-based** para TypeScript. Ele traz a
ergonomia do **SQLAlchemy 2.0** — modelos declarados como classes, schema como
fonte única da verdade — pro mundo JS/TS, com inferência de tipos forte do começo
ao fim: você define a tabela uma vez e o TypeScript sabe o formato de cada linha
em todo `select`, `insert`, `update` e `delete`.

É a camada de dados do futuro **`tempest-ts-sdk`**.

> :material-translate: **Idiomas / Languages** — esta documentação é bilíngue.
> Use o seletor de idioma no topo da página pra alternar entre
> **Português (BR)** e **English (US)**.

!!! warning "Status: pré-alpha (`v0.0.0`)"

    A inferência de tipos das Fases 1 e 2 está **provada e testada**, mas a
    superfície pública ainda está em construção e o pacote **ainda não foi
    publicado no npm**. A execução real contra banco (SQLite/PostgreSQL) chega na
    Fase 4 — veja o [Roadmap](roadmap.md).

## Por que Querium?

Você define o modelo **uma vez**, como classe — e o Querium infere todo o resto:

```ts
import { Model, column, type InferModel, type InferInsert } from "querium";

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
import { select } from "querium";

// O resultado é inferido como UserRow[] — sem anotação manual
const adults = select(User).where({ age: { gt: 18 } }).orderBy("age", "desc");

// Projeção infere Pick<UserRow, "id" | "name">[]
const names = select(User, ["id", "name"]);
```

## A realidade do TypeScript

O SQLAlchemy lê `Mapped[int]` em **runtime** via descriptors; o TypeScript **apaga
os tipos** na compilação. O Querium contorna isso fazendo cada coluna ser um
**builder com tipo em runtime** (`column.integer()`) que carrega ao mesmo tempo o
tipo SQL (runtime) e o tipo estático (inferência).

Você ganha a ergonomia de classes **e** inferência forte de resultado de query. O
trade-off: a linha retornada é um objeto plano inferido, não uma instância de
classe com métodos (active-record fica como objetivo pós-MVP). Detalhes em
[Arquitetura](architecture.md).

## Comece em 1 minuto

```bash
npm install querium
```

```ts
import { Model, column, select } from "querium";

class Task extends Model {
  static tablename = "tasks";
  id = column.integer().primaryKey();
  title = column.text().notNull();
  done = column.boolean().notNull();
}

const pending = select(Task).where({ done: false }).orderBy("id");
// `pending` carrega o tipo de resultado { id: number; title: string; done: boolean }[]
```

Novo por aqui? Siga o **[Tutorial — Comece aqui](tutorial/index.md)**: do primeiro
modelo a queries tipadas, um conceito por página.

## O que tem dentro

| Área | Páginas |
| --- | --- |
| **Tutorial** | [Comece aqui](tutorial/index.md) · [Modelos](tutorial/models.md) · [Consultas](tutorial/queries.md) · [Inserir, atualizar, deletar](tutorial/mutations.md) · [Executando queries](tutorial/execution.md) · [Joins](tutorial/joins.md) |
| **Guia** | [Arquitetura](architecture.md) · [Repository](repository.md) · [Migrações](migrations.md) · [Referência da API](reference.md) |
| **Projeto** | [Roadmap](roadmap.md) · [Contribuindo](contributing.md) · [Changelog](changelog.md) |

## Princípios

1. **Tipo é o produto.** Cada feature entrega testes de tipo, não só de runtime.
2. **Zero SQL por string.** Sempre parametrizado (a partir da Fase 4).
3. **Class-first, mas honesto com o TS.** Abraçamos o que o TS faz bem.
4. **Docs seguem o código.** Bilíngue, estilo tutorial, no mesmo commit.
