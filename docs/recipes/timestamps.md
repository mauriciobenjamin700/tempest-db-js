# created_at / updated_at

**Problema:** quase toda tabela quer saber *quando* a linha foi criada e *quando* foi
atualizada pela última vez — mas setar isso na mão em todo `insert`/`update` é fácil de
esquecer e fácil de errar.

**Solução:** deixe o **banco** preencher, com defaults portáveis (`sql.now()`) e
`onUpdate(...)`. O tempest-db-js renderiza a SQL certa por dialeto (`CURRENT_TIMESTAMP`
no SQLite, `now()` no PostgreSQL).

## A teoria em uma frase

- `.default(sql.now())` → o valor é preenchido **no INSERT** se você não passar nada.
- `.onUpdate(sql.now())` → o valor é **reaplicado a cada UPDATE**, automaticamente.

É o mesmo modelo do `server_default` + `onupdate` do SQLAlchemy.

## O modelo

```ts
import { Model, column, sql } from "tempest-db-js";

class Article extends Model {
  static tablename = "articles";
  id = column.integer().primaryKey();
  title = column.text().notNull();
  createdAt = column.datetime().notNull().default(sql.now());            // setado no insert
  updatedAt = column.datetime().notNull().default(sql.now()).onUpdate(sql.now()); // e a cada update
}
```

Como `createdAt` e `updatedAt` têm default, eles ficam **opcionais no insert** — o tipo
`InferInsert` reflete isso:

```ts
import { type InferInsert } from "tempest-db-js";

type ArticleInsert = InferInsert<typeof Article>;
// { title: string; id?: number; createdAt?: Date; updatedAt?: Date }
//   ^ você só precisa passar `title`
```

## Em uso

```ts
import { insert, update, select } from "tempest-db-js";

// INSERT — não passamos os timestamps; o banco preenche os dois
session.execute(insert(Article).values({ title: "Olá, mundo" }));

const [article] = session.execute(select(Article)).all();
console.log(article.createdAt); // Date — preenchido pelo banco
console.log(article.updatedAt); // Date — igual ao createdAt nesse momento

// UPDATE — não tocamos em updatedAt; o onUpdate cuida disso
session.execute(update(Article).set({ title: "Título novo" }).where({ id: article.id }));

const [fresh] = session.execute(select(Article)).all();
console.log(fresh.updatedAt > fresh.createdAt); // true — updatedAt avançou sozinho
```

!!! info "O default fica guardado na coluna"

    O valor de `.default()`/`.onUpdate()` fica em `Article.createdAt.defaultValue` —
    é exatamente o que alimenta o IR de migração. Ou seja: o mesmo modelo dirige tanto a
    execução quanto a geração de `CREATE TABLE`. Uma fonte da verdade só.

## Variações úteis

=== "Só created_at"

    ```ts
    createdAt = column.datetime().notNull().default(sql.now());
    ```

=== "UUID como PK"

    ```ts
    id = column.uuid().primaryKey().default(sql.uuidv4()); // gerado no banco
    ```

=== "Com timezone (PostgreSQL)"

    ```ts
    createdAt = column.datetime({ timezone: true }).notNull().default(sql.now());
    // → TIMESTAMP WITH TIME ZONE
    ```

## Recap

- `.default(sql.now())` preenche no INSERT; `.onUpdate(sql.now())` reaplica no UPDATE.
- Colunas com default viram **opcionais** em `InferInsert` — você não passa timestamp.
- Expressões portáveis (`sql.now()`, `sql.uuidv4()`, …) viram a SQL certa por dialeto.
- O mesmo default alimenta as migrações — schema e runtime nunca divergem.
