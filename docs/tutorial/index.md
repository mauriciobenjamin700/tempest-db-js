# Tutorial — Comece aqui

Bem-vindo! 🚀 Este é o **Tutorial — Guia do Usuário** do tempest-db-js. Ele é **linear**:
cada página ensina **um conceito**, em cima do anterior, com exemplos completos
que você pode copiar e colar. Comece aqui e siga os links de "próxima página" — você
nunca vai ficar travado.

Ao longo do tutorial vamos modelar **o mesmo mini-domínio**, página a página: um
gerenciador de tarefas com usuários. Nada de teoria solta — cada conceito entra
porque o domínio precisa dele.

## O que é o tempest-db-js?

É um ORM para TypeScript onde você declara suas tabelas como **classes** e o
TypeScript infere o formato de cada linha automaticamente. Se você já usou o
SQLAlchemy 2.0 em Python, vai se sentir em casa:

=== "tempest-db-js (TypeScript)"

    ```ts
    import { Model, column } from "tempest-db-js";

    class User extends Model {
      static tablename = "users";
      id = column.integer().primaryKey();
      name = column.text().notNull();
    }
    ```

=== "SQLAlchemy (Python)"

    ```python
    from sqlalchemy.orm import Mapped, mapped_column

    class User(Base):
        __tablename__ = "users"
        id: Mapped[int] = mapped_column(primary_key=True)
        name: Mapped[str] = mapped_column()
    ```

A diferença-chave: o Python lê os tipos em runtime; o TypeScript apaga os tipos na
compilação. Por isso, no tempest-db-js, **a coluna é um valor** (`column.integer()`) que
carrega o tipo — não uma anotação. Você vai entender bem isso na próxima página.

## Antes de começar

Garanta os pré-requisitos da [Instalação](../installation.md): Node ≥ 20,
TypeScript ≥ 5.7 e `strict: true` no `tsconfig.json`.

!!! info "Você não precisa de um banco ainda"

    Tudo neste tutorial — declarar modelos, montar `select`/`insert`/`update`/
    `delete` — acontece **no nível de tipos**, sem tocar em banco nenhum. A
    execução real (`session.execute`) chega na Fase 4. Então você pode seguir o
    tutorial inteiro só com o compilador do TypeScript.

## O caminho

1. **[Modelos](models.md)** — declare tabelas como classes e infira os tipos de
   linha (`InferModel`, `InferInsert`).
2. **[Consultas](queries.md)** — monte `SELECT` tipado, com projeção, filtros e
   ordenação.
3. **[Inserir, atualizar, deletar](mutations.md)** — `INSERT`/`UPDATE`/`DELETE`
   tipados, incluindo o guard que evita apagar uma tabela inteira sem querer.

Pronto? Vamos pro primeiro modelo. 👉 **[Modelos](models.md)**
