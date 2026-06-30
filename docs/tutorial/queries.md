# Consultas

Com o modelo `User` da página anterior, vamos montar consultas `SELECT`. No
tempest-db-js, `select(...)` devolve um **builder encadeável** que carrega o tipo do
resultado — antes mesmo de tocar num banco.

!!! info "Montar é separado de executar"

    `select(...)` monta uma **AST tipada** — não toca no banco sozinho. Quem roda é
    o `session.execute(...)`, que você vê em **[Executando queries](execution.md)**.
    Separar as duas coisas deixa toda a segurança de tipos testável só com o
    compilador, e o `select` reaproveitável em qualquer sessão.

## Passo 1 — Selecionar tudo

```ts
import { select } from "tempest-db-js";

const q = select(User);
```

O tipo de resultado de `q` é `UserRow[]` — todas as colunas, inferidas da classe.
Sem anotação manual.

## Passo 2 — Filtrar com `where`

```ts
const adults = select(User).where({ age: { gt: 18 } });
```

As **chaves** de `where` são checadas contra as colunas de `User`. Errar o nome é
erro de compilação:

```ts
// ❌ erro: `agee` não é coluna de User
select(User).where({ agee: { gt: 18 } });
```

### Operadores tipados por coluna

O **valor** de cada filtro aceita um match exato (shorthand de `eq`) ou um objeto de
operador. E o conjunto de operadores é **restrito ao tipo da coluna** — usar um
operador inválido é erro de compilação:

| Tipo da coluna | Operadores |
| --- | --- |
| `string` (varchar/text/uuid/enum) | `eq`, `ne`, `in`, `notIn`, `like`, `ilike`, `isNull` |
| `number` / `bigint` / `Date` | `eq`, `ne`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `between`, `isNull` |
| `boolean` | `eq`, `ne`, `isNull` |
| json / blob | `eq`, `ne`, `in`, `notIn`, `isNull` |

```ts
select(User).where({
  age: { gt: 18, lte: 65 },     // ✅ ordenados em number
  name: { like: "%Ben%" },      // ✅ like em string
  active: true,                 // ✅ shorthand de eq
  tags: { isNull: false },      // ✅ em qualquer coluna
});

// ❌ erro de compilação: `like` não existe em number
select(User).where({ age: { like: "%18%" } });

// ❌ erro de compilação: `gt` não existe em string
select(User).where({ name: { gt: "a" } });
```

!!! check "Por que isso importa"

    O operador errado pro tipo da coluna é um bug que normalmente só aparece em
    runtime (ou nunca). Aqui ele **não compila** — o tipo da coluna carrega quais
    comparações fazem sentido.

### Combinadores `and` / `or` / `not`

A forma objeto é um **AND implícito**. Pra `OR`, `NOT` ou aninhar lógica, use os
combinadores `and`/`or`/`not` — eles funcionam em `select`, `update`, `delete` e
`join`:

```ts
import { and, or, not } from "tempest-db-js";

// (age < 18) OR (age > 65)
select(User).where(or({ age: { lt: 18 } }, { age: { gt: 65 } }));

// active AND NOT (age < 18)
select(User).where(and({ active: true }, not({ age: { lt: 18 } })));
```

!!! tip "Key-safety nos combinadores"

    A forma objeto no topo (`where({...})`) já checa as chaves contra as colunas.
    Dentro dos combinadores, passe o tipo da linha pra checagem total —
    `or<UserRow>({...}, {...})` — senão as chaves ficam permissivas.

## Passo 3 — Ordenar, limitar, paginar

Os métodos encadeiam e são imutáveis (cada um devolve um novo builder):

```ts
const page = select(User)
  .where({ age: { gte: 18 } })
  .orderBy("age", "desc")
  .limit(20)
  .offset(40);
```

`orderBy` também valida a coluna:

```ts
// ❌ erro: `bogus` não é coluna de User
select(User).orderBy("bogus");
```

## Passo 4 — Projeção com `Pick`

Quer só algumas colunas? Passe a lista no segundo argumento de `select`. O tipo de
resultado vira um `Pick` exato:

```ts
const names = select(User, ["id", "name"]);
// resultado inferido: Pick<UserRow, "id" | "name">[]
//   → { id: number; name: string }[]
```

A projeção **sobrevive ao encadeamento** — `where`, `orderBy`, `limit` não a
desfazem:

```ts
const q = select(User, ["id", "age"])
  .where({ age: { gt: 18 } })
  .orderBy("age", "desc");
// resultado: { id: number; age: number }[]
```

E projetar uma coluna inexistente é erro de compilação:

```ts
// ❌ erro: `missing` não é coluna de User
select(User, ["id", "missing"]);
```

## Inspecionando a AST

O builder expõe sua AST em `.node` — útil pra debug e pra entender o que será
compilado pra SQL pelo dialeto:

```ts
const q = select(User, ["id", "name"]).where({ age: { gt: 18 } }).limit(10);

console.log(q.node);
// {
//   kind: "select",
//   table: "users",
//   columns: ["id", "name"],
//   where: { age: { gt: 18 } },
//   orderBy: [],
//   limit: 10,
//   offset: undefined,
// }
```

## Recap

- `select(Model)` → builder com resultado `Row[]`.
- `select(Model, [cols])` → resultado projetado `Pick<Row, cols>[]`.
- `.where({...})` valida as **chaves** contra as colunas e os **operadores por tipo**.
- `.orderBy(col, dir)`, `.limit(n)`, `.offset(n)` encadeiam e são imutáveis.
- A AST fica em `.node`; rodar é com `session.execute` — **[próxima parte](mutations.md)**.

Agora vamos **escrever** dados. 👉 **[Inserir, atualizar, deletar](mutations.md)**
