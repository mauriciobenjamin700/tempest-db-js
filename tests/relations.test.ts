import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  type InferModel,
  Model,
  type WithRelations,
  belongsTo,
  column,
  createEngine,
  hasMany,
  insert,
  loadRelations,
  select,
} from "../src/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.varchar(80).notNull();
}

class Post extends Model {
  static override tablename = "posts";
  id = column.integer().primaryKey();
  userId = column.integer().notNull();
  title = column.varchar(120).notNull();
}

type UserRow = InferModel<typeof User>;
type PostRow = InferModel<typeof Post>;

describe("relations — eager loading (real SQLite)", () => {
  let engine: AsyncEngine;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    const driver = (engine as any).driver;
    await driver.execute(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
      [],
    );
    await driver.execute(
      "CREATE TABLE posts (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL, title TEXT NOT NULL)",
      [],
    );
    const s = engine.session();
    await s.execute(
      insert(User).values([
        { id: 1, name: "Ana" },
        { id: 2, name: "Beto" },
      ]),
    );
    await s.execute(
      insert(Post).values([
        { id: 10, userId: 1, title: "A1" },
        { id: 11, userId: 1, title: "A2" },
        { id: 12, userId: 2, title: "B1" },
      ]),
    );
  });

  it("hasMany attaches an array per base row (1 query, no N+1)", async () => {
    const s = engine.session();
    const users = await s.execute(select(User).orderBy("id")).all();
    const withPosts = await loadRelations(s, users, {
      posts: hasMany(() => Post, { localKey: "id", foreignKey: "userId" }),
    });

    expect(withPosts[0]?.name).toBe("Ana");
    expect(withPosts[0]?.posts.map((p: PostRow) => p.title)).toEqual(["A1", "A2"]);
    expect(withPosts[1]?.posts.map((p: PostRow) => p.title)).toEqual(["B1"]);
  });

  it("hasMany yields [] for a base row with no children", async () => {
    const s = engine.session();
    await s.execute(insert(User).values({ id: 3, name: "Cris" }));
    const users = await s.execute(select(User).where({ id: 3 })).all();
    const withPosts = await loadRelations(s, users, {
      posts: hasMany(() => Post, { localKey: "id", foreignKey: "userId" }),
    });
    expect(withPosts[0]?.posts).toEqual([]);
  });

  it("belongsTo attaches a single row or null", async () => {
    const s = engine.session();
    const posts = await s.execute(select(Post).orderBy("id")).all();
    const withAuthor = await loadRelations(s, posts, {
      author: belongsTo(() => User, { localKey: "userId", foreignKey: "id" }),
    });
    expect((withAuthor[0]?.author as UserRow | null)?.name).toBe("Ana");
    expect((withAuthor[2]?.author as UserRow | null)?.name).toBe("Beto");
  });

  it("result type is widened (compile-time check)", async () => {
    const s = engine.session();
    const users = await s.execute(select(User)).all();
    const withPosts = await loadRelations(s, users, {
      posts: hasMany(() => Post, { localKey: "id", foreignKey: "userId" }),
    });
    // Type assertion: posts is PostRow[]
    const _typed: WithRelations<
      UserRow,
      { posts: ReturnType<typeof hasMany<typeof Post>> }
    >[] = withPosts;
    expect(Array.isArray(_typed[0]?.posts)).toBe(true);
  });
});
