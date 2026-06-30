# Blog (relations + joins)

Um blog mínimo — **usuários**, **posts** e **comentários** — para mostrar as duas formas
de combinar tabelas no tempest-db-js: **relations declarativas** (navegar `user.posts`,
`post.author` sem N+1) e **joins** (um tipo composto numa query só). Você escolhe a que
deixa o código mais claro pra cada caso.

## 1. Os modelos

```ts
import { Model, column, sql } from "tempest-db-js";

class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
}

class Post extends Model {
  static tablename = "posts";
  id = column.integer().primaryKey();
  userId = column.integer().notNull();          // FK → users.id
  title = column.text().notNull();
  createdAt = column.datetime().notNull().default(sql.now());
}

class Comment extends Model {
  static tablename = "comments";
  id = column.integer().primaryKey();
  postId = column.integer().notNull();          // FK → posts.id
  body = column.text().notNull();
}
```

## 2. Banco + tabelas

`loadRelations` precisa de uma sessão **async**, então criamos as tabelas com um
`MigrationRunner` (driver sync) e abrimos um engine async sobre o **mesmo arquivo**:

```ts
import { createEngine, NodeSqliteDriver, insert, select } from "tempest-db-js";
import { MigrationRunner, reflectTable, type Migration } from "tempest-db-js/migrations";

const driver = NodeSqliteDriver.open("blog.db");
const init: Migration = {
  revision: "init",
  downRevision: [],
  up: (op) => {
    op.createTable(reflectTable(User));
    op.createTable(reflectTable(Post));
    op.createTable(reflectTable(Comment));
  },
  down: (op) => {
    op.dropTable(reflectTable(Comment));
    op.dropTable(reflectTable(Post));
    op.dropTable(reflectTable(User));
  },
};
new MigrationRunner(driver, "sqlite").upgrade([init], new Date().toISOString());

const engine = createEngine("sqlite:///blog.db"); // async, mesmo arquivo
const session = engine.session();
```

## 3. Seed

```ts
await session.execute(insert(User).values([{ name: "Ana" }, { name: "Beto" }]));
await session.execute(insert(Post).values([
  { userId: 1, title: "Olá, mundo" },
  { userId: 1, title: "Segundo post" },
  { userId: 2, title: "Post do Beto" },
]));
await session.execute(insert(Comment).values([
  { postId: 1, body: "Top!" },
  { postId: 1, body: "Curti" },
]));
```

## 4. Relations: navegar sem N+1

`hasMany` carrega uma lista; `belongsTo` carrega um (ou `null`). `loadRelations` faz
**uma query por relação** — não uma por linha.

=== "hasMany — posts de cada usuário"

    ```ts
    import { hasMany, loadRelations } from "tempest-db-js";

    const users = await session.execute(select(User).orderBy("id")).all();
    const withPosts = await loadRelations(session, users, {
      posts: hasMany(() => Post, { localKey: "id", foreignKey: "userId" }),
    });

    withPosts[0].posts; // PostRow[] — os posts da Ana, já tipados
    console.log(withPosts[0].name, "tem", withPosts[0].posts.length, "posts"); // Ana tem 2 posts
    ```

=== "belongsTo — autor de cada post"

    ```ts
    import { belongsTo, loadRelations } from "tempest-db-js";

    const posts = await session.execute(select(Post).orderBy("id")).all();
    const withAuthor = await loadRelations(session, posts, {
      author: belongsTo(() => User, { localKey: "userId", foreignKey: "id" }),
    });

    withAuthor[0].author; // UserRow | null
    console.log(withAuthor[0].title, "por", withAuthor[0].author?.name); // Olá, mundo por Ana
    ```

!!! check "Por que isso evita o N+1"

    Sem `loadRelations`, carregar o autor de 100 posts seria 1 query pros posts + 100
    pros autores. Aqui são **2 queries no total**: uma pros posts, uma pros autores
    (`WHERE id IN (...)`), casadas em memória. O tipo do resultado já vem ampliado.

## 5. Joins: tudo numa query

Quando você quer **uma linha plana por combinação** (e não navegar relações), o join é
mais direto. O resultado é um objeto com uma chave por alias:

```ts
import { join } from "tempest-db-js";

const rows = await session.execute(
  join(Post, "post")
    .innerJoin(User, "author", { "post.userId": "author.id" })
    .where({ "author.name": "Ana" })
    .orderBy("post.createdAt", "desc"),
).all();
// rows: { post: PostRow; author: UserRow }[]

for (const { post, author } of rows) {
  console.log(`${post.title} — ${author.name}`);
}
```

`leftJoin` mantém a esquerda mesmo sem match — e o tipo do lado direito vira `| null`,
te obrigando a tratar:

```ts
const postsWithMaybeComment = await session.execute(
  join(Post, "post").leftJoin(Comment, "comment", { "post.id": "comment.postId" }),
).all();
// { post: PostRow; comment: CommentRow | null }[]

for (const row of postsWithMaybeComment) {
  console.log(row.post.title, row.comment ? row.comment.body : "(sem comentários)");
}
```

## Relations × joins — quando usar qual?

| Use **relations** quando… | Use **joins** quando… |
| --- | --- |
| quer navegar objetos (`user.posts[0].title`) | quer linhas planas por combinação |
| as relações são listas (1-N) e você quer agrupado | precisa filtrar/ordenar por colunas de várias tabelas juntas |
| quer evitar N+1 carregando em lote | quer uma única query com `WHERE` cruzado |

## Recap

- `hasMany`/`belongsTo` + `loadRelations` → navegação tipada, 1 query por relação.
- `join(...).innerJoin/leftJoin` → tipo composto `{ [alias]: Row }`; `leftJoin` nullable.
- Relations precisam de sessão **async**; joins rodam em sync ou async.
- Escolha pela clareza: navegar objetos → relations; linha plana cruzada → join.
