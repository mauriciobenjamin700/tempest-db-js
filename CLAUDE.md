# tempest-db-js

ORM type-safe e class-based para TypeScript, com ergonomia do SQLAlchemy 2.0.
Pacote npm publicado (layout flat: código em `src/`, testes em `tests/`, sem
wrapper de app).

## Escopo de bancos — foco em SQLite + PostgreSQL

**MySQL está de lado por enquanto.** O trabalho ativo é **SQLite e PostgreSQL**.

O que isso significa na prática:

- **Não iniciar feature nova de MySQL.** Os gaps conhecidos dele — introspecção
  via `information_schema` (sem ela `tempest-db check` não detecta drift no
  MySQL), `RETURNING` em `UPDATE`/`DELETE`, `LIMIT` dentro de subquery — ficam
  parados até o escopo ser revisto. Não abrir issue nem entrada de roadmap para
  eles.
- **Não deixar o MySQL bloquear entrega.** Quando um recurso novo não tem
  equivalente no MySQL, a saída é o padrão que o projeto já usa: **erro explícito
  no dialeto**, documentado, em vez de fallback silencioso ou de segurar a
  feature. Já é assim em `forUpdate` no SQLite, `column.array()` fora do
  PostgreSQL e no predicado de `ON CONFLICT`.
- **O que existe continua funcionando.** O `MysqlDialect`, o driver `mysql2`
  (peer opcional), o read-back de `RETURNING` e o job `mysql` do CI ficam onde
  estão e devem continuar verdes. "De lado" é sobre investimento novo, não sobre
  remoção nem sobre deixar regredir.
- **Decisão de design se resolve por SQLite + PostgreSQL.** Se um trade-off só
  faz sentido por causa do MySQL, escolha o que serve os outros dois e registre a
  limitação.

Nenhum outro banco entra no escopo (MariaDB como dialeto separado, MSSQL, Oracle)
sem o usuário revisitar isso.

## Comandos

```bash
npm test                 # vitest (inclui os type-level tests)
npm run test:types       # tsc --noEmit
npm run lint             # biome check
npm run build            # tsup (ESM + CJS + .d.ts)
```

Testes de integração são **gated por env var** e pulados sem ela:

```bash
TEST_DATABASE_URL=postgresql://postgres:test@localhost:5433/tdbjs npm test
TEST_MYSQL_URL=mysql://root:test@localhost:3307/tdbjs npm test
```

Os arquivos `tests/postgres*.integration.test.ts` rodam **em paralelo contra o
mesmo banco**. Um teste que asserta sobre o schema global (o `check` do CLI, por
exemplo) precisa do **próprio banco** — veja
`tests/postgres-cli.integration.test.ts`. Antes de empurrar, rode os arquivos de
integração juntos algumas vezes: interferência entre eles é flaky e passa numa
execução isolada.

## Convenções específicas deste repo

- **SQL nasce só no dialeto** (`src/dialect.ts`) e nos renderers de DDL
  (`src/migrations/ddl.ts`). Nenhum `.sql` solto, sempre parametrizado.
- **Nome de coluna é resolvido num ponto só** (`columnId`/`qualify` no dialeto),
  a partir do mapa que o node carrega. Um caminho novo que escreva identificador
  direto fura o `.name()` / `static naming`.
- **Erro explícito por dialeto** onde o recurso não existe, nunca degradação
  silenciosa — o mesmo modelo não pode ter semântica diferente por banco.
- Docs bilíngues (`<pág>.md` + `<pág>.en.md`) e ambos os blocos `nav:` do
  `mkdocs.yml`; `mkdocs build --strict` com zero warning antes de cortar release.
