# Blog (relations + joins)

A minimal blog — **users**, **posts** and **comments** — to show the two ways of
combining tables in tempest-db-js: **declarative relations** (navigate `user.posts`,
`post.author` with no N+1) and **joins** (a composite type in a single query). You pick
whichever makes the code clearer for each case.

## 1. The models

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

## 2. Database + tables

`loadRelations` needs an **async** session, so we create the tables with a
`MigrationRunner` (sync driver) and open an async engine over the **same file**:

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

const engine = createEngine("sqlite:///blog.db"); // async, same file
const session = engine.session();
```

## 3. Seed

```ts
await session.execute(insert(User).values([{ name: "Ann" }, { name: "Bob" }]));
await session.execute(insert(Post).values([
  { userId: 1, title: "Hello, world" },
  { userId: 1, title: "Second post" },
  { userId: 2, title: "Bob's post" },
]));
await session.execute(insert(Comment).values([
  { postId: 1, body: "Nice!" },
  { postId: 1, body: "Loved it" },
]));
```

## 4. Relations: navigate with no N+1

`hasMany` loads a list; `belongsTo` loads one (or `null`). `loadRelations` runs
**one query per relation** — not one per row.

=== "hasMany — each user's posts"

    ```ts
    import { hasMany, loadRelations } from "tempest-db-js";

    const users = await session.execute(select(User).orderBy("id")).all();
    const withPosts = await loadRelations(session, users, {
      posts: hasMany(() => Post, { localKey: "id", foreignKey: "userId" }),
    });

    withPosts[0].posts; // PostRow[] — Ann's posts, already typed
    console.log(withPosts[0].name, "has", withPosts[0].posts.length, "posts"); // Ann has 2 posts
    ```

=== "belongsTo — each post's author"

    ```ts
    import { belongsTo, loadRelations } from "tempest-db-js";

    const posts = await session.execute(select(Post).orderBy("id")).all();
    const withAuthor = await loadRelations(session, posts, {
      author: belongsTo(() => User, { localKey: "userId", foreignKey: "id" }),
    });

    withAuthor[0].author; // UserRow | null
    console.log(withAuthor[0].title, "by", withAuthor[0].author?.name); // Hello, world by Ann
    ```

!!! check "Why this avoids the N+1"

    Without `loadRelations`, loading the author of 100 posts would be 1 query for the posts
    + 100 for the authors. Here it's **2 queries in total**: one for the posts, one for the
    authors (`WHERE id IN (...)`), matched in memory. The result type comes back widened.

## 5. Joins: everything in one query

When you want **one flat row per combination** (rather than navigating relations), the
join is more direct. The result is an object with one key per alias:

```ts
import { join } from "tempest-db-js";

const rows = await session.execute(
  join(Post, "post")
    .innerJoin(User, "author", { "post.userId": "author.id" })
    .where({ "author.name": "Ann" })
    .orderBy("post.createdAt", "desc"),
).all();
// rows: { post: PostRow; author: UserRow }[]

for (const { post, author } of rows) {
  console.log(`${post.title} — ${author.name}`);
}
```

`leftJoin` keeps the left side even without a match — and the right side's type becomes
`| null`, forcing you to handle it:

```ts
const postsWithMaybeComment = await session.execute(
  join(Post, "post").leftJoin(Comment, "comment", { "post.id": "comment.postId" }),
).all();
// { post: PostRow; comment: CommentRow | null }[]

for (const row of postsWithMaybeComment) {
  console.log(row.post.title, row.comment ? row.comment.body : "(no comments)");
}
```

## Relations vs. joins — when to use which?

| Use **relations** when… | Use **joins** when… |
| --- | --- |
| you want to navigate objects (`user.posts[0].title`) | you want flat rows per combination |
| the relations are lists (1-N) and you want them grouped | you need to filter/sort by columns from several tables together |
| you want to avoid N+1 by batch-loading | you want a single query with a cross-table `WHERE` |

## Recap

- `hasMany`/`belongsTo` + `loadRelations` → typed navigation, 1 query per relation.
- `join(...).innerJoin/leftJoin` → composite type `{ [alias]: Row }`; `leftJoin` nullable.
- Relations need an **async** session; joins run in sync or async.
- Choose by clarity: navigating objects → relations; flat cross-table row → join.
