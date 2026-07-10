# Receitas

As **receitas** resolvem um problema pontual de cada vez — código completo, copy-paste,
com a teoria do *por quê* logo ao lado. São o complemento prático do
[Tutorial](../tutorial/index.md): o tutorial te ensina os conceitos em ordem; as
receitas mostram como aplicá-los em situações reais do dia a dia.

!!! tip "Como ler"

    Cada receita é independente — pule direto pra que você precisa. Todas assumem que
    você já passou pelo [Tutorial](../tutorial/index.md) (modelos, queries, execução).

## Disponíveis

| Receita | Resolve |
| --- | --- |
| [Chaves estrangeiras e UNIQUE](constraints.md) | FK, UNIQUE de coluna e constraints de tabela (composto/nomeado), estilo SQLAlchemy. |
| [created_at / updated_at](timestamps.md) | Timestamps gerenciados pelo banco, sem lembrar de setar na mão. |
| [Paginação tipada](pagination.md) | Listas paginadas com total/páginas, alinhadas ao `tempest-fastapi-sdk`. |
| [Agregações e DISTINCT](aggregations.md) | `count`/`sum`/`avg`/`min`/`max` + `GROUP BY` tipado e `DISTINCT`. |
| [Upsert (ON CONFLICT)](upsert.md) | Inserir resolvendo conflito de chave: `DO NOTHING` ou `DO UPDATE`. |
| [Active-record (opt-in)](active-record.md) | Métodos `save`/`update`/`delete`/`reload` numa linha, quando você prefere. |
| [Logging e erros](logging.md) | Ver o SQL que roda (`onQuery`) e erros com o SQL/params que falharam. |
| [Transações e savepoints](transactions.md) | Operações atômicas com commit/rollback automático e pontos de salvamento. |
| [Colunas JSON e enum](json-enum.md) | Guardar objetos tipados e uniões literais com segurança de tipos. |
| [Serialização (linha ↔ JSON)](serialization.md) | Converter linhas pra JSON e validar JSON de volta pra linha. |
| [Conectando ao PostgreSQL](postgres.md) | Trocar SQLite por Postgres pela URL e ajustar o pool. |

## Procurando algo maior?

Se você quer ver tudo junto num projeto que roda, vá pra **[Exemplos](../examples/index.md)**:
um Todo CLI, um blog com relations, uma REST API e o fluxo completo de migrações.
