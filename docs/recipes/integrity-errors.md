# Respondendo 409 com a constraint certa

O banco diz **por que** recusou a escrita — e diz na prosa do driver, não na da sua
aplicação. `parseIntegrityError` lê essa prosa de volta para uma estrutura:

```ts
import { BaseRepository, parseIntegrityError } from "tempest-db-js";

try {
  await users.create({ email, tenantId });
} catch (error) {
  const failure = parseIntegrityError(error, User);   // (1)!
  if (failure?.violation === "unique" && failure.columns.includes("email")) {
    return json({ code: "EMAIL_TAKEN", field: "email" }, { status: 409 });
  }
  throw error;                                        // (2)!
}
```

1. O modelo é opcional; passá-lo traduz o nome **do banco** de volta para a propriedade
   (`idempotency_key` → `idempotencyKey`) em quem usa `naming = "snake_case"`.
2. Não é violação de integridade ⇒ `null`. Reerguer é o certo: engolir aqui esconderia
   erro de sintaxe, deadlock, queda de conexão.

## O que volta

| Campo | Traz |
| --- | --- |
| `violation` | `"unique"` · `"foreignKey"` · `"notNull"` · `"check"` · `"exclusion"` |
| `constraint` | nome, quando o banco reporta (PostgreSQL sim, SQLite não) |
| `table` | tabela, quando reportada |
| `columns` | colunas cobertas — **todas** numa constraint composta |
| `detail` | a mensagem crua do driver, para o log |

## O que cada banco entrega

O mesmo erro chega de duas formas diferentes, e a diferença não é cosmética:

=== "PostgreSQL"

    ```
    code: "23505"
    constraint_name: "uq_users_email_tenant_id"
    detail: "Key (email, tenant_id)=(a@b, 7) already exists."
    ```

    Nome da constraint e a lista de colunas numa linha `DETAIL:` — por isso as colunas
    saem de lá, e não de `column_name`, que só traz uma.

=== "SQLite"

    ```
    message: "UNIQUE constraint failed: users.email"
    code: "SQLITE_CONSTRAINT_UNIQUE"   (better-sqlite3)
    errcode: 2067                       (node:sqlite)
    ```

    Tabela e colunas dentro da mensagem, nome da constraint em lugar nenhum. Os dois
    drivers do SQLite reportam o **código** de formas diferentes; os dois são
    reconhecidos.

!!! warning "MySQL devolve `null`"

    O MySQL está fora do escopo ativo do projeto, então um `ER_DUP_ENTRY` devolve `null`
    em vez de um palpite. `null` significa "não sei", não "não foi violação" — trate
    reerguendo, como qualquer erro desconhecido.

!!! tip "Constraint composta vem inteira"

    `columns` traz **todas** as colunas de uma unique composta, que é exatamente o que
    decide se a mensagem para o usuário fala de e-mail ou do par (e-mail, tenant).

## Recapitulando

- `parseIntegrityError(error, Model?)` → `IntegrityFailure | null`.
- Segue a cadeia de `cause`, então o `QueryExecutionError` do pacote não atrapalha.
- Passe o modelo para receber nome de propriedade em vez de nome de coluna.
- `null` ⇒ reerga o erro. 🚀
