# Tipos de coluna próprios

Dinheiro como centavos inteiros, `Temporal.Instant`, id com brand, value object: a
conversão pertence à **coluna**, não a todo call site que esquece de fazer.

```ts
import { column, customType } from "tempest-db-js";

const money = customType<Money, bigint>({
  base: () => column.bigInteger(),   // (1)!
  toDb: (value) => value.cents,
  fromDb: (cents) => Money.fromCents(cents),
});

class Order extends Model {
  static override tablename = "orders";
  id = column.integer().primaryKey();
  total = money().notNull();         // (2)!
}
```

1. **Fábrica**, não coluna pronta: cada declaração precisa da própria instância.
2. Compõe com `.notNull()`, `.default()`, `.unique()` como qualquer coluna.

## Onde a conversão acontece

| Caminho | O que roda |
| --- | --- |
| `create` / `createMany` / `update` | `toDb` antes de ligar o valor |
| linha lida (`select`, `RETURNING`, `stream`, join) | `fromDb` depois da coerção base |
| `where` (valor solto, operador, lista de `in`, `between`) | `toDb` no operando |
| DDL e IR de migração | **nada** — o schema usa o tipo `base` |

```ts
await orders.list({ total: new Money(900n) });   // compara em centavos, no banco
```

!!! info "O schema não sabe do tipo custom — e é por isso que não gera drift"

    O DDL emite o tipo `base` (`BIGINT`), então introspecção e `tempest-db check` veem uma
    coluna comum. Um tipo próprio é uma decisão da aplicação; se ele aparecesse no schema,
    todo banco existente passaria a divergir.

!!! warning "`null` passa direto"

    `toDb`/`fromDb` **não** são chamados para `null`/`undefined` — coluna anulável
    continua anulável, e o codec não precisa tratar o caso.

!!! danger "Expressão SQL não é valor de domínio"

    `set({ total: sql.raw("total + 1") })` **não** passa pelo `toDb`: é SQL a ser
    renderizado, não um valor a converter. Se a expressão precisa casar com a
    representação armazenada, escreva-a nessa representação.

## Recapitulando

- `customType({ base, toDb, fromDb })` devolve a fábrica de coluna.
- Converte na escrita, na leitura e no operando de `where`.
- O schema continua sendo o do tipo base. 🚀
