# Guia

O **Guia** reúne o material de referência e de fundo — o *como funciona* e o *o que
existe*, pra quando você já passou pelo [Tutorial](../tutorial/index.md) e quer entender
as decisões de design ou consultar a API.

## Nesta seção

| Página | O que cobre |
| --- | --- |
| [Arquitetura](../architecture.md) | Por que a coluna é um valor, o trade-off do active-record, como builders viram AST + tipos fantasma, e o mapa dos módulos. |
| [Repository](../repository.md) | `BaseRepository<Model>` — CRUD + paginação tipada, convenção 404, relations (eager-load sem N+1) e como estender pra seu domínio. |
| [Migrações](../migrations.md) | Sistema estilo Alembic: Schema IR, diff, codegen, grafo DAG, runner, batch-mode SQLite, drift e CLI. |
| [Referência da API](../reference.md) | Toda a superfície pública num lugar: `column`, `select`/`insert`/`update`/`del`, engine/sessão, joins, relations, serialização, migrações. |

## Por onde começar

- Quer **entender as escolhas** do tempest-db-js? → [Arquitetura](../architecture.md).
- Vai montar uma **camada de dados de serviço**? → [Repository](../repository.md).
- Precisa **evoluir o schema** com segurança? → [Migrações](../migrations.md).
- Só quer **procurar uma função**? → [Referência da API](../reference.md).

!!! tip "Procurando exemplos práticos?"

    O Guia explica os conceitos; pra ver tudo rodando junto, vá pros
    [Exemplos](../examples/index.md), e pra resolver um problema pontual, às
    [Receitas](../recipes/index.md).
