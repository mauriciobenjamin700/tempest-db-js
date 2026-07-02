# Roadmap

O tempest-db-js é construído em fases, cada uma entregando uma fatia testável.
**As Fases 0–9 estão concluídas** e publicadas na `v0.3.0`. O que resta são os
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

## Bancos suportados — foco em 3

O tempest-db-js mira **exatamente três bancos: SQLite, PostgreSQL e MySQL** — e
nenhum outro por enquanto. Os três têm dialeto, execução e migração.

| Banco | Status |
| --- | --- |
| **SQLite** | ✅ Completo e testado (`node:sqlite`). |
| **PostgreSQL** | ✅ Execução real, transações (conexão reservada), `SERIAL`, enum nomeado, introspecção/drift — testados contra um Postgres real no CI. Migração **sync e async** (`AsyncMigrationRunner`). |
| **MySQL** | 🟢 Dialeto completo (crases, `ON DUPLICATE KEY UPDATE`, `AUTO_INCREMENT`, `MODIFY COLUMN`), driver `mysql2` (lazy). Compilação testada. Falta: execução no CI e `RETURNING` via `LAST_INSERT_ID`. |

## O que já roda (v0.3.0)

Modelos declarativos + inferência, query builder tipado (**agregações**,
**`DISTINCT`**, **upsert** `ON CONFLICT`/`ON DUPLICATE KEY`), joins compostos com
operadores tipados no `where`, relations sem N+1, execução real SQLite+PostgreSQL,
dialeto MySQL, migrações **sync + async** com CLI `tempest-db` (rename interativo,
drift, `--sql`), `BaseRepository` + paginação, **active-record opt-in**, e DX
(`QueryExecutionError` + `onQuery`). Ver [Receitas](recipes/index.md) e
[Exemplos](examples/index.md).

## Próximos passos

### Follow-ups dos bancos (curto prazo)

- **MySQL no CI** — subir um serviço MySQL no workflow e rodar os testes de
  execução (hoje só a compilação é testada; execução é gated como era o PG).
- **`RETURNING` no MySQL** — round-trip via `LAST_INSERT_ID()` + `SELECT`, para
  `repository.create` e `activeRecord.save` funcionarem no MySQL (o dialeto hoje
  lança em `.returning()`).
- **CLI async** — plugar o `tempest-db` no `AsyncMigrationRunner` para rodar
  migração pelo CLI contra Postgres/MySQL, não só SQLite.

### Fase 10 — `tempest-ts-sdk` (repo próprio)

Pacote separado (flat-layout) consumindo o tempest-db-js, espelhando o
`tempest-fastapi-sdk`: `BaseRepository` estendido, settings via env, hierarquia
`AppException`, integração HTTP.

### Fase 11 — Query API avançada

`HAVING` nas agregações, subqueries (IN/EXISTS/scalar), prepared-query API
explícita, unit-of-work/identity-map opcional pro active-record.

### Fase 12 — Rumo a `v1.0`

Congelar a API pública, cobertura de testes, docs completas, critérios de saída
do alpha.

!!! info "Detalhes completos no repositório"

    O `ROADMAP.md` na raiz do repositório tem a linha do tempo detalhada, riscos e
    decisões de design por fase.
