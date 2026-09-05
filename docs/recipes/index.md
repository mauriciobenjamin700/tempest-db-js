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
| [Mixins de modelo](mixins.md) | `withTimestamps`, `withSoftDelete`, `withAudit` — as colunas repetidas em toda tabela, declaradas uma vez. |
| [Paginação tipada](pagination.md) | Listas paginadas com total/páginas, alinhadas ao `tempest-fastapi-sdk`. |
| [Agregações e DISTINCT](aggregations.md) | `count`/`sum`/`avg`/`min`/`max` + `GROUP BY` tipado e `DISTINCT`. |
| [Upsert (ON CONFLICT)](upsert.md) | Inserir resolvendo conflito de chave: `DO NOTHING` ou `DO UPDATE`. |
| [Active-record (opt-in)](active-record.md) | Métodos `save`/`update`/`delete`/`reload` numa linha, quando você prefere. |
| [Logging e erros](logging.md) | Ver o SQL que roda (`onQuery`) e erros com o SQL/params que falharam. |
| [Erros de integridade (409)](integrity-errors.md) | Ler o erro do driver de volta para a constraint que recusou a escrita. |
| [Signals do repositório](signals.md) | `preSave`/`postSave`/`preDelete`/`postDelete` — reagir a escrita sem envolver todo call site. |
| [Escolhendo o driver do SQLite](sqlite-drivers.md) | `node:sqlite` (padrão) ou `better-sqlite3`, pela opção do engine ou pelo sufixo da URL. |
| [Transações e savepoints](transactions.md) | Operações atômicas com commit/rollback automático e pontos de salvamento. |
| [Colunas JSON e enum](json-enum.md) | Guardar objetos tipados e uniões literais com segurança de tipos. |
| [Serialização (linha ↔ JSON)](serialization.md) | Converter linhas pra JSON e validar JSON de volta pra linha. |
| [Conectando ao PostgreSQL](postgres.md) | Trocar SQLite por Postgres pela URL e ajustar o pool. |
| [Fila durável com PostgreSQL](queue.md) | `FOR UPDATE SKIP LOCKED`, contador atômico e idempotência por índice parcial. |
| [Outbox transacional](outbox.md) | Linha de negócio e evento no mesmo commit; relay com lotes disjuntos. |
| [Nomes de coluna](naming.md) | Schema em `snake_case` com modelo em `camelCase`, sem drift falso. |
| [Colunas array do PostgreSQL](arrays.md) | `text[]`/`integer[]` tipados, com `@>`, `<@` e `&&`. |
| [Comparação case-insensitive](case-insensitive.md) | `ieq` para login sem diferenciar caixa — e a armadilha do `ilike`. |
| [Busca de texto](text-search.md) | `contains` escapado e portátil; `fullText`/`fullTextRank` com stemming no PostgreSQL. |
| [SQL cru em runtime](raw-sql.md) | `session.raw` para a query que o builder ainda não expressa. |
| [Expressões no `where`](expressions.md) | Coluna vs coluna e funções SQL, para casar índice funcional. |
| [Operações de conjunto](set-operations.md) | `UNION`, `UNION ALL`, `INTERSECT`, `EXCEPT` com a forma dos ramos checada no tipo. |
| [MySQL: o que muda](mysql.md) | `RETURNING` por read-back e o que o MySQL não faz. |

## Procurando algo maior?

Se você quer ver tudo junto num projeto que roda, vá pra **[Exemplos](../examples/index.md)**:
um Todo CLI, um blog com relations, uma REST API e o fluxo completo de migrações.
