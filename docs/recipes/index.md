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
| [created_at / updated_at](timestamps.md) | Timestamps gerenciados pelo banco, sem lembrar de setar na mão. |
| [Paginação tipada](pagination.md) | Listas paginadas com total/páginas, alinhadas ao `tempest-fastapi-sdk`. |
| [Transações e savepoints](transactions.md) | Operações atômicas com commit/rollback automático e pontos de salvamento. |
| [Colunas JSON e enum](json-enum.md) | Guardar objetos tipados e uniões literais com segurança de tipos. |

## Procurando algo maior?

Se você quer ver tudo junto num projeto que roda, vá pra **[Exemplos](../examples/index.md)**:
um Todo CLI, um blog com relations, uma REST API e o fluxo completo de migrações.
