# Mixins de modelo

As mesmas colunas aparecem em quase toda tabela: quando a linha nasceu, quando foi
tocada, se foi apagada, quem mexeu. Escrever isso modelo a modelo é repetição que
**deriva** — uma tabela ganha `updatedAt` sem `onUpdate`, outra chama de `updatedOn`.

Mixin é uma função que recebe a classe base e devolve uma subclasse com as colunas
extras. Espelha o `SoftDeleteMixin` / `AuditMixin` do `tempest-fastapi-sdk`.

## Timestamps

```ts
import { Model, column, withTimestamps } from "tempest-db-js";

class Article extends withTimestamps(Model) {
  static override tablename = "articles";
  id = column.integer().primaryKey();
  title = column.text().notNull();
}
```

Você ganha duas colunas:

| Coluna | Tipo | Comportamento |
| --- | --- | --- |
| `createdAt` | `Date` | `NOT NULL DEFAULT` do relógio do banco (`sql.now()`) |
| `updatedAt` | `Date` | idem, mais `onUpdate(sql.now())` — todo `UPDATE` reescreve |

```ts
const row = await articles.create({ title: "olá" });  // não passa timestamp nenhum
row.createdAt;  // Date
await articles.update({ id: row.id }, { title: "oi" });
// UPDATE articles SET "title" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE ...
```

!!! info "`onUpdate` é aplicado na escrita, não no schema"

    Só o MySQL tem `ON UPDATE` de coluna. Renderizar isso no DDL faria o mesmo modelo
    se comportar diferente por banco, então o valor é injetado no `UPDATE` que o
    builder monta — e um valor explícito no seu `set()` **sempre vence**.

## Soft delete

```ts
import { Model, column, notDeleted, onlyDeleted, select, withSoftDelete } from "tempest-db-js";

class Article extends withSoftDelete(withTimestamps(Model)) {
  static override tablename = "articles";
  id = column.integer().primaryKey();
  title = column.text().notNull();
}

session.execute(select(Article).where(notDeleted()));   // deletedAt IS NULL
session.execute(select(Article).where(onlyDeleted()));  // deletedAt IS NOT NULL
```

!!! warning "Filtrar é responsabilidade de quem consulta"

    O mixin declara a coluna e nada mais. Não existe filtro global escondido — uma
    query que esquece o `notDeleted()` **vê** as linhas apagadas. É deliberado: filtro
    invisível é o tipo de mágica que faz um `count()` discordar do outro. Componha
    `notDeleted()` onde importa, ou crie um índice parcial `WHERE deletedAt IS NULL`.

## Auditoria de autor

```ts
import { Model, column, withAudit } from "tempest-db-js";

class Article extends withAudit(Model) {          // createdBy/updatedBy como uuid
  static override tablename = "articles";
  id = column.integer().primaryKey();
}

class Order extends withAudit(Model, () => column.integer()) {  // id de usuário inteiro
  static override tablename = "orders";
  id = column.integer().primaryKey();
}
```

As duas colunas são **anuláveis** de propósito: linha criada por job de background não
tem autor, e um valor-sentinela ali mente pior que um `NULL`. É uma **fábrica**
(`() => column.integer()`), não uma coluna pronta, porque as duas propriedades precisam
de instâncias independentes.

## Compondo

```ts
class Article extends withAudit(withSoftDelete(withTimestamps(Model))) {
  static override tablename = "articles";
  id = column.integer().primaryKey();
  title = column.text().notNull();
}
```

As colunas do mixin vêm **antes** das suas na ordem do modelo — a mesma convenção do
`reorder_base_columns_first` do SDK. São colunas de verdade: aparecem no `InferModel`,
no `InferInsert`, no IR de migração e no DDL gerado.

## Recapitulando

- `withTimestamps` → `createdAt` + `updatedAt` (com `onUpdate`).
- `withSoftDelete` → `deletedAt`; filtre com `notDeleted()` / `onlyDeleted()`.
- `withAudit` → `createdBy` + `updatedBy`, tipo do autor configurável.
- Compõem entre si e com o resto do modelo, sem nada de especial no resto do pacote. 🚀
