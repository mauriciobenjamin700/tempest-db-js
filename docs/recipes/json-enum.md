# Colunas JSON e enum

**Problema:** nem todo dado cabe numa coluna escalar. Você quer guardar um **objeto**
(preferências, metadados) ou restringir uma coluna a um **conjunto fechado de valores**
(status, papel) — e quer que o TypeScript saiba o formato em vez de te entregar um
`any` ou uma `string` solta.

**Solução:** `column.json<T>()` carrega o tipo `T` do valor parseado; `column.enum(...)`
infere uma **união literal** dos valores que você passar.

## JSON tipado

Passe o tipo do conteúdo como parâmetro genérico — ele se propaga pra leitura e escrita:

```ts
import { Model, column, type InferModel } from "tempest-db-js";

interface Prefs {
  theme: "light" | "dark";
  notifications: boolean;
}

class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  prefs = column.json<Prefs>().notNull();   // JSON → Prefs
}

type UserRow = InferModel<typeof User>;
// { id: number; name: string; prefs: Prefs }
```

Na leitura, o valor já vem **parseado e tipado**:

```ts
import { insert, select } from "tempest-db-js";

session.execute(insert(User).values({
  name: "Ana",
  prefs: { theme: "dark", notifications: true }, // checado contra Prefs
}));

const [user] = session.execute(select(User)).all();
user.prefs.theme;          // "light" | "dark" — autocomplete funciona
// user.prefs.bogus;       // ❌ erro: não existe em Prefs
```

!!! tip "JSONB no PostgreSQL"

    Use `column.jsonb<T>()` pra renderizar `JSONB` (binário, indexável) no PostgreSQL.
    A API e a inferência são idênticas — muda só o tipo SQL gerado.

## Enum: união literal

`column.enum(...)` aceita os valores como argumentos `const` e infere a união:

```ts
class Ticket extends Model {
  static tablename = "tickets";
  id = column.integer().primaryKey();
  status = column.enum("open", "pending", "closed").notNull();
}

type TicketRow = InferModel<typeof Ticket>;
// { id: number; status: "open" | "pending" | "closed" }
```

O tipo barra valores fora do conjunto **em tempo de compilação**:

```ts
session.execute(insert(Ticket).values({ status: "open" }));     // ✅
// session.execute(insert(Ticket).values({ status: "urgent" })); // ❌ não compila

// e no filtro também:
session.execute(select(Ticket).where({ status: { in: ["open", "pending"] } })).all();
```

!!! info "Enum nomeado no PostgreSQL"

    No SQLite o enum vira um `TEXT` com checagem no nível de tipo. No PostgreSQL, a
    migração gera um **`CREATE TYPE ... AS ENUM`** nomeado de verdade. Mesmo modelo,
    DDL idiomática por dialeto.

## Coerção na serialização

`toJSON`/`fromDict` respeitam esses tipos: JSON é serializado/parseado, e o enum é
validado como string. Veja a [Referência](../reference.md#serializacao).

## Recap

- `column.json<T>()` (ou `jsonb<T>()`) carrega o tipo do conteúdo — leitura e escrita tipadas.
- `column.enum("a", "b")` infere a união literal `"a" | "b"`; valor fora não compila.
- Enum vira `CREATE TYPE` nomeado no PostgreSQL; `TEXT` checado no SQLite.
