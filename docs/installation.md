# Instalação

## Requisitos

- **Node.js ≥ 20** (ou um runtime compatível).
- **TypeScript ≥ 5.7** — o tempest-db-js depende de recursos modernos de inferência de
  tipos. Versões mais antigas podem não inferir as linhas corretamente.

!!! success "Disponível no npm (`v0.1.0`)"

    O tempest-db-js já está publicado no [npm](https://www.npmjs.com/package/tempest-db-js)
    e é usável de ponta a ponta. Instale com seu gerenciador favorito:

## Instalar

=== "npm"

    ```bash
    npm install tempest-db-js
    ```

=== "pnpm"

    ```bash
    pnpm add tempest-db-js
    ```

=== "yarn"

    ```bash
    yarn add tempest-db-js
    ```

## Drivers de banco (peer dependencies)

O tempest-db-js **não embute** um driver de banco — você escolhe e instala o que vai
usar. Os drivers são `peerDependencies` **opcionais**, então instalar o tempest-db-js
não puxa nenhum banco junto.

| Banco | Driver | Pacote |
| --- | --- | --- |
| SQLite | `node:sqlite` (embutido no Node) | **nada a instalar** |
| SQLite (alternativa) | `better-sqlite3` | `npm install better-sqlite3` |
| PostgreSQL | `postgres` (postgres.js) | `npm install postgres` |

!!! tip "SQLite funciona sem instalar nada"

    Por padrão o tempest-db-js usa o módulo **`node:sqlite` embutido no Node ≥ 20** —
    então você já consegue executar queries SQLite reais sem nenhum pacote extra.
    `better-sqlite3` é uma alternativa opcional; PostgreSQL precisa do `postgres`.

## Configuração do TypeScript

O tempest-db-js assume um `tsconfig.json` em modo **strict**. O mínimo recomendado:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

!!! tip "Por que `strict`?"

    A inferência do tempest-db-js é construída sobre o sistema de tipos estrito do TS.
    Com `strict: false`, a nullability das colunas (`string | null`) e os guards de
    UPDATE/DELETE perdem força — exatamente as garantias pelas quais você adotou um
    ORM tipado. Mantenha `strict: true`.

## Verifique a instalação

Um programa completo que **cria a tabela, insere e lê** — só com API pública:

```ts
import {
  Model, column, select, insert, createSyncEngine, NodeSqliteDriver,
} from "tempest-db-js";
import { MigrationRunner, reflectTable, type Migration } from "tempest-db-js/migrations";

class Ping extends Model {
  static tablename = "ping";
  id = column.integer().primaryKey();
  label = column.text().notNull();
}

// 1. cria a tabela com uma migração pontual (detalhes em "Migrações")
const driver = NodeSqliteDriver.open("verify.db");
const migration: Migration = {
  revision: "init",
  downRevision: [],
  up: (op) => op.createTable(reflectTable(Ping)),
  down: (op) => op.dropTable(reflectTable(Ping)),
};
new MigrationRunner(driver, "sqlite").upgrade([migration], new Date().toISOString());

// 2. executa queries tipadas contra o mesmo banco
const session = createSyncEngine("sqlite:///verify.db").session();
session.execute(insert(Ping).values({ label: "ok" }));
console.log(session.execute(select(Ping)).all()); // [{ id: 1, label: "ok" }]
```

Se isso roda sem erros (e compila com `tsc --noEmit`), está tudo certo. ✅

!!! tip "Só quer um smoke test rápido?"

    Pra confirmar só o import e a tipagem, sem tocar em disco, monte uma query e
    inspecione a AST: `console.log(select(Ping).node.table) // "ping"`.

## Recap

- Node ≥ 20, TypeScript ≥ 5.7, `strict: true`.
- `npm install tempest-db-js` — já no npm (`v0.1.0`).
- SQLite roda direto (`node:sqlite` embutido); pra PostgreSQL, `npm install postgres`.
- Próximo: monte seu primeiro modelo no **[Tutorial](tutorial/index.md)**.
