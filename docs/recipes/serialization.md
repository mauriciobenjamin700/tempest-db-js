# Serialização (linha ↔ JSON)

**Problema:** uma linha do banco tem tipos nativos — `Date`, `bigint`, `Uint8Array` — que
**não sobrevivem ao `JSON.stringify`** sozinhos (`bigint` lança, `Date` vira string sem
controle, `blob` vira lixo). E quando um JSON chega de fora (request HTTP, fila), você
quer **validar e coagir** de volta pros tipos certos antes de gravar.

**Solução:** o tempest-db-js traz um par de funções que conhecem o schema do modelo —
`toJSON`/`stringify` pra **sair**, `fromDict`/`parse` pra **entrar** — à la
`model_dump`/`model_validate` do Pydantic.

## A teoria em uma frase

A serialização é **dirigida pelo modelo**: cada função olha as colunas da classe e coage
cada campo pelo tipo SQL dele. Colunas desconhecidas são ignoradas; obrigatórias que
faltam viram erro de validação.

## Saída: linha → JSON

```ts
import { Model, column, toJSON, stringify, toDict } from "tempest-db-js";

class Event extends Model {
  static tablename = "events";
  id = column.bigInteger().primaryKey();        // bigint
  name = column.text().notNull();
  at = column.datetime().notNull();             // Date
  payload = column.blob().notNull();            // Uint8Array
}

const row = {
  id: 9007199254740993n,
  name: "deploy",
  at: new Date("2026-06-29T12:00:00Z"),
  payload: new Uint8Array([1, 2, 3]),
};

toJSON(Event, row);
// {
//   id: "9007199254740993",            // bigint → string (sem perder precisão)
//   name: "deploy",
//   at: "2026-06-29T12:00:00.000Z",    // Date → ISO
//   payload: "AQID",                    // Uint8Array → base64
// }

stringify(Event, row); // == JSON.stringify(toJSON(Event, row))
```

!!! info "`toDict` vs `toJSON`"

    - `toDict(Model, row)` devolve os **valores nativos**, restritos às colunas conhecidas
      (sem coerção) — útil pra passar adiante dentro do TS.
    - `toJSON(Model, row)` devolve uma versão **JSON-safe** (`Date`→ISO, `bigint`→string,
      `Uint8Array`→base64) — pronta pro `JSON.stringify` / resposta HTTP.

## Entrada: JSON/dict → linha validada

`fromDict` coage cada campo de volta pro tipo nativo (string→`Date`/`bigint`/`Uint8Array`,
`JSON.parse` em colunas json) e **valida obrigatórios**:

```ts
import { fromDict, parse, ValidationError } from "tempest-db-js";

const row = fromDict(Event, {
  id: "9007199254740993",          // string → bigint
  name: "deploy",
  at: "2026-06-29T12:00:00.000Z",  // string → Date
  payload: "AQID",                  // base64 → Uint8Array
});
row.at instanceof Date; // true

// parse = fromDict(Model, JSON.parse(json))
const fromHttp = parse(Event, requestBodyString);
```

Faltou uma coluna obrigatória (`notNull` e sem default)? `ValidationError`:

```ts
try {
  fromDict(Event, { id: "1" }); // faltam name, at, payload
} catch (err) {
  if (err instanceof ValidationError) {
    console.error(err.message); // descreve as colunas obrigatórias ausentes
  }
}
```

!!! tip "Onde isso encaixa numa API"

    Numa rota HTTP: `parse(Model, await req.text())` pra validar o corpo na **entrada**, e
    `toJSON(Model, row)` pra montar a resposta na **saída**. O `BaseRepository` já devolve
    linhas nativas — serialize só na borda. Veja o [exemplo REST API](../examples/rest-api.md).

## Recap

- `toJSON`/`stringify` → linha → JSON-safe (`Date`→ISO, `bigint`→string, `blob`→base64).
- `toDict` → valores nativos restritos às colunas (sem coerção).
- `fromDict`/`parse` → JSON/dict → linha validada e coagida; lança `ValidationError`.
- Tudo **dirigido pelo schema do modelo** — uma fonte da verdade, igual ao Pydantic.
