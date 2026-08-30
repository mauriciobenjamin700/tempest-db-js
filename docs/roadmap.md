# Roadmap

O tempest-db-js é construído em fases, cada uma entregando uma fatia testável.
**As Fases 0–11 estão concluídas** e publicadas na `v0.6.0`. O que resta são os
follow-ups dos bancos, o pacote `tempest-ts-sdk` e o caminho até a `v1.0`.

| Fase | Tema | Status |
| --- | --- | --- |
| 0 | Toolchain + CI + testes de tipo | ✅ Concluída |
| 1 | Schema declarativo class-based + inferência | ✅ Concluída |
| 2 | Query builder tipado (SELECT/INSERT/UPDATE/DELETE) | ✅ Concluída |
| 3 | Operadores tipados por tipo de coluna | ✅ Concluída |
| 4 | Dialetos + execução real (`Session`) | ✅ + `.stream()`/pool/`using`/benchmark |
| 5 | Joins + tipos compostos + relations | ✅ + relations + and/or/not + operadores no join |
| 6 | Migrações + CLI | ✅ + drift + batch SQLite + enum PG + rename + bin |
| 7 | Repository + agregações/upsert + active-record + DX | ✅ Concluída |
| 8 | Migração async (fecha PostgreSQL) | ✅ `AsyncMigrationRunner` |
| 9 | Dialeto MySQL | ✅ `MysqlDialect` + DDL + driver `mysql2` |
| 10 | Buracos do primeiro consumidor real | ✅ Lock de linha, expressões no `set`, `session.raw`, naming, arrays, `ieq` |
| 11 | Query API avançada + MySQL e CLI | ✅ Subquery em `IN`, `HAVING`, `col`/`fn`, `RETURNING` no MySQL, CLI async |

## Bancos suportados — foco em 3

O tempest-db-js mira **exatamente três bancos: SQLite, PostgreSQL e MySQL** — e
nenhum outro por enquanto. Os três têm dialeto, execução e migração.

| Banco | Status |
| --- | --- |
| **SQLite** | ✅ Completo e testado (`node:sqlite`). |
| **PostgreSQL** | ✅ Execução real, transações (conexão reservada), `SERIAL`, enum nomeado, introspecção/drift — testados contra um Postgres real no CI. Migração **sync e async** (`AsyncMigrationRunner`). |
| **MySQL** | ✅ Execução real testada no CI (MySQL 8), `RETURNING` por read-back (`LAST_INSERT_ID`), lock de linha, upsert. Falta: introspecção via `information_schema` (então `check` não detecta drift lá). |

## O que já roda (v0.6.0)

Modelos declarativos + inferência (com **nome de coluna explícito** e naming
strategy), query builder tipado (**agregações**, **`DISTINCT`**, **upsert**
`ON CONFLICT`/`ON DUPLICATE KEY` com **predicado de índice parcial**, **lock de
linha** `FOR UPDATE SKIP LOCKED`, **expressões SQL no `set`**), **colunas array do
PostgreSQL** com `@>`/`<@`/`&&`, joins compostos com operadores tipados no `where`,
relations sem N+1, execução real SQLite+PostgreSQL, dialeto MySQL, migrações
**sync + async** com CLI `tempest-db` (rename interativo, drift, `--sql`),
`BaseRepository` + paginação, **active-record opt-in**, escape hatch
**`session.raw`**, **subquery em `IN`**, **`HAVING`**, **expressões no `where`**
(`col`/`fn`), e DX (`QueryExecutionError` + `onQuery`). Ver
[Receitas](recipes/index.md) e [Exemplos](examples/index.md).

## Próximos passos

### Follow-ups dos bancos (curto prazo)

- **Introspecção MySQL** — ler o schema via `information_schema`, para o
  `tempest-db check` detectar drift no MySQL (hoje devolve "não implementado").
- **Subquery `EXISTS` e escalar** — `IN`/`NOT IN` já aceitam subquery; falta o
  resto.
- **Tipagem de operando em `col()`/`fn.*`** — hoje o **nome** da coluna é checado,
  o tipo do operando não.

### Fase 12 — `tempest-ts-sdk` (repo próprio)

Pacote separado (flat-layout) consumindo o tempest-db-js, espelhando o
`tempest-fastapi-sdk`: `BaseRepository` estendido, settings via env, hierarquia
`AppException`, integração HTTP.

### Fase 13 — Query API: o que ainda falta

Subquery `EXISTS` e escalar, prepared-query API explícita, unit-of-work/identity-map
opcional pro active-record.

### Fase 14 — Rumo a `v1.0`

Congelar a API pública, cobertura de testes, docs completas, critérios de saída
do alpha.

!!! info "Detalhes completos no repositório"

    O `ROADMAP.md` na raiz do repositório tem a linha do tempo detalhada, riscos e
    decisões de design por fase.
