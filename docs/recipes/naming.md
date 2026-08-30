# Nomes de coluna (`snake_case` no banco, `camelCase` no código)

Manter a convenção do SQL no banco sem deixar ela vazar para o domínio TypeScript.

## O problema

`snake_case` é a convenção universal em SQL. `camelCase` é a convenção universal
em TypeScript. Se o nome da coluna for sempre o nome da propriedade, você é
forçado a escolher entre duas coisas ruins:

1. **Propriedade em `snake_case`** — funciona, mas `InferModel` passa a render
   `{ consumer_name: string, rate_limit_burst: number }`, e esse tipo circula por
   service, controller e schema de resposta. A convenção do banco vaza até a borda
   HTTP.
2. **Renomear as colunas do banco** — quebra a convenção SQL, exige aspas em toda
   query manual e, num banco em produção, é migração de renomeação em tabela
   quente.

O SQLAlchemy resolve com `mapped_column("consumer_name")`, o Django com
`db_column`, o Prisma com `@map`. Aqui são duas formas.

## Por coluna — `.name()`

```ts
import { Model, column } from "tempest-db-js";

class ApiKey extends Model {
  static tablename = "api_keys";

  id = column.integer().primaryKey();
  consumerName = column.text().name("consumer_name").notNull();  // (1)!
  rateLimitBurst = column.integer().name("rate_limit_burst").notNull();
}
```

1. A propriedade continua `consumerName` no TypeScript; a coluna é
   `consumer_name` no banco.

## Por tabela — `static naming`

Quando o schema inteiro segue uma convenção só, anotar coluna por coluna é ruído:

```ts
class ApiKey extends Model {
  static tablename = "api_keys";
  static naming = "snake_case";  // (1)!

  id = column.integer().primaryKey();
  consumerName = column.text().notNull();      // -> consumer_name
  rateLimitBurst = column.integer().notNull(); // -> rate_limit_burst
}
```

1. Os valores são `"preserve"` (o padrão — nome da propriedade, verbatim) e
   `"snake_case"`.

`.name()` continua valendo e **vence** a estratégia da tabela, para a exceção que
todo schema real tem:

```ts
class ApiKey extends Model {
  static tablename = "api_keys";
  static naming = "snake_case";

  consumerName = column.text().notNull();               // -> consumer_name
  legacyId = column.text().name("legacyID").notNull();  // -> legacyID
}
```

## O mapeamento vale em todo lugar

Não é um detalhe do `SELECT`. O nome traduzido aparece em toda cláusula que chega
ao SQL, e o nome da propriedade em tudo que volta para o TypeScript:

```ts
select(ApiKey, ["consumerName"])
  .where({ consumerName: { ieq: "acme" } })
  .orderBy("rateLimitBurst", "desc");
// SELECT "consumer_name" FROM "api_keys"
//  WHERE lower("consumer_name") = lower($1) ORDER BY "rate_limit_burst" DESC

const row = await session.execute(select(ApiKey).where({ consumerName: "acme" })).one();
row.consumerName;  // ✅ propriedade, não "consumer_name"
```

Cobertura completa: `select` (projeção, `where`, `orderBy`, `groupBy`,
agregações), `insert` (colunas, `ON CONFLICT` target e predicado, `returning`),
`update` (`set` e `where`), `del`, joins (qualificação `"alias"."coluna"`),
`BaseRepository`, active-record, e o **IR das migrações**.

!!! check "Sem drift falso"

    O IR de migração é gerado em espaço de **nome de coluna**, igual ao que a
    introspecção lê do banco. Por isso `checkDriftPostgres` continua limpo — se o
    mapeamento só valesse na query, toda coluna renomeada apareceria como
    "missing from the database".

!!! warning "Colisão é erro, não última-escrita-vence"

    Duas propriedades que resolvem para a mesma coluna levantam erro na primeira
    reflexão do modelo:

    ```
    api_keys: properties "userName" and "user_name" both map to column "user_name".
    ```

## Custo

Um modelo que não renomeia nada tem mapa `null`, e o compilador nem consulta —
o caminho quente fica idêntico ao de antes. O mapa é memoizado por classe, como o
resto da reflexão de modelo.

## Recap

- `.name("coluna")` renomeia uma coluna; `static naming = "snake_case"` renomeia
  a tabela toda.
- `.name()` sobrescreve a estratégia da tabela.
- O mapeamento cobre query, mutação, join, repository e o IR de migração — sem
  drift falso.
- A linha que volta é sempre em nome de propriedade.
- Colisão de nomes falha alto.
