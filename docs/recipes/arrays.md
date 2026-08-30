# Colunas array do PostgreSQL

Modelar `text[]` / `integer[]` — nativos e comuns no Postgres — com tipo inferido
e operadores de verdade.

## O problema

```sql
CREATE TABLE api_keys (
    id      SERIAL PRIMARY KEY,
    scopes  text[] NOT NULL DEFAULT ARRAY['send']::text[]
);
```

Sem um tipo array, sobra declarar a coluna como `jsonb` e torcer. Isso *funciona*
hoje — o valor vai cru para o driver e o postgres.js serializa `string[]` sozinho
— e é justamente o problema: o comportamento certo depende da lib **não** coagir o
valor. E o `checkDriftPostgres` reporta drift eterno, já que o modelo diz `jsonb` e
o banco diz `text[]`.

## `column.array()`

```ts
import { Model, column } from "tempest-db-js";

class ApiKey extends Model {
  static tablename = "api_keys";

  id = column.integer().primaryKey();
  scopes = column.array(column.text()).notNull().default(["send"]);  // (1)!
  quotas = column.array(column.integer());                            // (2)!
}
```

1. DDL: `"scopes" TEXT[] NOT NULL DEFAULT ARRAY['send']::TEXT[]`.
   Tipo inferido: `string[]`.
2. DDL: `"quotas" INTEGER[]`. Tipo inferido: `number[] | null`.

O elemento é uma coluna qualquer, então o tipo estático vem junto:

```ts
type ApiKeyRow = InferModel<typeof ApiKey>;
// { id: number; scopes: string[]; quotas: number[] | null }
```

## Operadores

Um array que só dá para ler inteiro não vale muito. Os operadores nativos do
Postgres estão no `where`, tipados só para colunas array:

| Operador | SQL | Significado |
| --- | --- | --- |
| `contains` | `@>` | a coluna contém todos os elementos dados |
| `containedBy` | `<@` | todos os elementos da coluna estão no valor dado |
| `overlaps` | `&&` | coluna e valor compartilham ao menos um elemento |

```ts
// Chaves que podem enviar
select(ApiKey).where({ scopes: { contains: ["send"] } });
// SELECT * FROM "api_keys" WHERE "scopes" @> $1

// Chaves com algum escopo de leitura
select(ApiKey).where({ scopes: { overlaps: ["read", "read:all"] } });
// SELECT * FROM "api_keys" WHERE "scopes" && $1
```

```ts
// @ts-expect-error - `contains` não existe em coluna escalar
select(ApiKey).where({ id: { contains: [1] } });
```

## Portabilidade: erro explícito, não fallback

SQLite e MySQL não têm array nativo. O dialeto **lança erro** ao renderizar o DDL
ou o operador, em vez de cair para JSON silenciosamente:

```
column.array() is PostgreSQL-only — sqlite has no native array type.
Model the column as JSON there, accepting that array operators will not work.
```

!!! info "Por que erro e não fallback"

    Um fallback silencioso faria o **mesmo modelo** ter semântica diferente por
    dialeto: `@>` funcionaria num banco e não no outro, e o teste em SQLite
    passaria enquanto a produção em Postgres quebra. Falhar na compilação do DDL
    é o momento barato de descobrir isso.

    Se o serviço precisa dos dois, declare `column.json<string[]>()` e aceite que
    o filtro por elemento é feito na aplicação.

## Drift e migração

O IR carrega o tipo do elemento (`{ kind: "array", meta: { element } }`), e a
introspecção do Postgres desempacota `data_type = ARRAY` + `udt_name = _text` de
volta para o mesmo formato. Resultado: `checkDriftPostgres` fica limpo, e um
`text[]` no banco não é mais lido como `text`.

## Leitura e escrita

O driver do Postgres entrega arrays nativos, e a camada de coerção decodifica cada
elemento pelo tipo declarado:

```ts
const row = await session.execute(select(ApiKey).where({ id: 1 })).one();
row.scopes;  // ["send", "read"] — string[], não string
```

Escrita é direta:

```ts
await session
  .execute(update(ApiKey).set({ scopes: ["send", "read"] }).where({ id: 1 }))
  .rowsAffected();
```

!!! tip "Default com expressão"

    `default(["send"])` vira `ARRAY['send']::TEXT[]`. Para um default que o
    builder não modela, use `sql.raw("'{}'::text[]")`.

## Recap

- `column.array(column.text())` → `text[]`, com `string[]` inferido.
- `contains` (`@>`), `containedBy` (`<@`) e `overlaps` (`&&`) no `where`,
  tipados só para colunas array.
- SQLite e MySQL lançam erro explícito — sem fallback silencioso para JSON.
- Migração e drift entendem o tipo do elemento.
