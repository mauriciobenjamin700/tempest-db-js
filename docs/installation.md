# Instalação

## Requisitos

- **Node.js ≥ 20** (ou um runtime compatível).
- **TypeScript ≥ 5.7** — o tempest-db-js depende de recursos modernos de inferência de
  tipos. Versões mais antigas podem não inferir as linhas corretamente.

!!! warning "Pré-alpha — ainda não está no npm"

    O tempest-db-js está em `v0.0.0` e **ainda não foi publicado**. Os comandos abaixo
    são a forma como a instalação vai funcionar quando a primeira versão sair. Por
    enquanto, use via repositório local (veja [Contribuindo](contributing.md)).

## Instalar

```bash
npm install tempest-db-js
```

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
| SQLite | `better-sqlite3` | `npm install better-sqlite3` |
| PostgreSQL | `postgres` (postgres.js) | `npm install postgres` |

!!! info "A execução chega na Fase 4"

    Hoje o tempest-db-js monta a **AST tipada** das queries, mas ainda não executa
    contra um banco — isso é a Fase 4 do [Roadmap](roadmap.md). Você já pode
    instalar e usar toda a tipagem de schema e query builder; o `session.execute`
    e os dialetos SQLite/PostgreSQL vêm em seguida.

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

```ts
import { Model, column, select } from "tempest-db-js";

class Ping extends Model {
  static tablename = "ping";
  id = column.integer().primaryKey();
}

const q = select(Ping);
console.log(q.node.table); // "ping"
```

Se isso compila com `tsc --noEmit` sem erros, está tudo certo. ✅

## Recap

- Node ≥ 20, TypeScript ≥ 5.7, `strict: true`.
- `npm install tempest-db-js` — sem driver embutido.
- Instale `better-sqlite3` e/ou `postgres` conforme o banco.
- Próximo: monte seu primeiro modelo no **[Tutorial](tutorial/index.md)**.
