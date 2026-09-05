import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  Model,
  column,
  createEngine,
  except,
  getDialect,
  insert,
  intersect,
  select,
  union,
  unionAll,
} from "../src/index.js";

class Post extends Model {
  static override tablename = "posts";
  id = column.integer().primaryKey();
  authorId = column.integer().notNull();
  createdAt = column.integer().notNull();
}

class Comment extends Model {
  static override tablename = "comments";
  id = column.integer().primaryKey();
  authorId = column.integer().notNull();
  createdAt = column.integer().notNull();
}

const DDL = [
  "CREATE TABLE posts (id INTEGER PRIMARY KEY, authorId INTEGER NOT NULL, createdAt INTEGER NOT NULL)",
  "CREATE TABLE comments (id INTEGER PRIMARY KEY, authorId INTEGER NOT NULL, createdAt INTEGER NOT NULL)",
];

function compile(builder: unknown, dialect: "sqlite" | "postgresql" | "mysql") {
  return getDialect(dialect).compile((builder as { node: never }).node);
}

describe("set operations — compilation", () => {
  const feed = () =>
    union(
      select(Post, ["id", "createdAt"]).where({ authorId: 1 }),
      select(Comment, ["id", "createdAt"]).where({ authorId: 1 }),
    );

  it("joins the branches with the keyword and orders the result", () => {
    const { sql, params } = compile(
      feed().orderBy("createdAt", "desc").limit(50),
      "postgresql",
    );
    expect(sql).toBe(
      'SELECT "id", "createdAt" FROM "posts" WHERE "authorId" = $1 UNION ' +
        'SELECT "id", "createdAt" FROM "comments" WHERE "authorId" = $2 ' +
        'ORDER BY "createdAt" DESC LIMIT $3',
    );
    expect(params).toEqual([1, 1, 50]);
  });

  it("renders each operator", () => {
    const two = [
      select(Post, ["id"]).where({ authorId: 1 }),
      select(Post, ["id"]).where({ authorId: 2 }),
    ] as const;
    expect(compile(unionAll(...two), "sqlite").sql).toContain("UNION ALL");
    expect(compile(intersect(...two), "sqlite").sql).toContain("INTERSECT");
    expect(compile(except(...two), "sqlite").sql).toContain("EXCEPT");
  });

  it("parenthesizes a branch that carries its own LIMIT", () => {
    const { sql } = compile(
      union(
        select(Post, ["id"]).orderBy("createdAt", "desc").limit(3),
        select(Comment, ["id"]),
      ),
      "postgresql",
    );
    expect(sql.startsWith("(SELECT")).toBe(true);
    expect(sql).toContain(') UNION SELECT "id" FROM "comments"');
  });

  it("refuses INTERSECT and EXCEPT on MySQL instead of emitting them", () => {
    const two = [
      select(Post, ["id"]).where({ authorId: 1 }),
      select(Post, ["id"]).where({ authorId: 2 }),
    ] as const;
    expect(() => compile(intersect(...two), "mysql")).toThrow(/out of scope/);
    expect(() => compile(except(...two), "mysql")).toThrow(/out of scope/);
    expect(compile(union(...two), "mysql").sql).toContain("UNION");
  });

  it("needs at least two branches", () => {
    expect(() => union(select(Post, ["id"]))).toThrow(/at least two/);
  });
});

describe("set operations — execution", () => {
  let engine: AsyncEngine;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    for (const stmt of DDL) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
    await engine.session().execute(
      insert(Post).values([
        { id: 1, authorId: 1, createdAt: 30 },
        { id: 2, authorId: 1, createdAt: 10 },
        { id: 3, authorId: 2, createdAt: 20 },
      ]),
    );
    await engine.session().execute(
      insert(Comment).values([
        { id: 1, authorId: 1, createdAt: 40 },
        { id: 4, authorId: 1, createdAt: 5 },
      ]),
    );
  });

  it("UNION removes duplicates, UNION ALL keeps them", async () => {
    const deduped = await engine
      .session()
      .execute(
        union(
          select(Post, ["id"]).where({ authorId: 1 }),
          select(Comment, ["id"]).where({ authorId: 1 }),
        ).orderBy("id"),
      )
      .all();
    expect(deduped.map((r) => r.id)).toEqual([1, 2, 4]);

    const all = await engine
      .session()
      .execute(
        unionAll(
          select(Post, ["id"]).where({ authorId: 1 }),
          select(Comment, ["id"]).where({ authorId: 1 }),
        ).orderBy("id"),
      )
      .all();
    expect(all.map((r) => r.id)).toEqual([1, 1, 2, 4]);
  });

  it("orders and limits the combined result", async () => {
    const rows = await engine
      .session()
      .execute(
        union(
          select(Post, ["id", "createdAt"]).where({ authorId: 1 }),
          select(Comment, ["id", "createdAt"]).where({ authorId: 1 }),
        )
          .orderBy("createdAt", "desc")
          .limit(2),
      )
      .all();
    expect(rows.map((r) => r.createdAt)).toEqual([40, 30]);
  });

  it("INTERSECT and EXCEPT compare the branches", async () => {
    const shared = await engine
      .session()
      .execute(
        intersect(
          select(Post, ["id"]).where({ authorId: 1 }),
          select(Comment, ["id"]).where({ authorId: 1 }),
        ),
      )
      .all();
    expect(shared.map((r) => r.id)).toEqual([1]);

    const only = await engine
      .session()
      .execute(
        except(
          select(Post, ["id"]).where({ authorId: 1 }),
          select(Comment, ["id"]).where({ authorId: 1 }),
        ).orderBy("id"),
      )
      .all();
    expect(only.map((r) => r.id)).toEqual([2]);
  });
});
