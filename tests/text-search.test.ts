import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  Model,
  column,
  contains,
  createEngine,
  escapeLike,
  fullText,
  fullTextRank,
  getDialect,
  insert,
  select,
} from "../src/index.js";

class Post extends Model {
  static override tablename = "posts";
  id = column.integer().primaryKey();
  title = column.varchar(120).notNull();
  body = column.text().notNull();
}

const DDL =
  "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL)";

/** Compile a builder for one dialect. */
function compile(builder: unknown, dialect: "sqlite" | "postgresql" | "mysql") {
  return getDialect(dialect).compile((builder as { node: never }).node);
}

describe("escapeLike", () => {
  it("escapes the wildcards and the escape character itself", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("back\\slash")).toBe("back\\\\slash");
    expect(escapeLike("plain")).toBe("plain");
  });
});

describe("contains — compilation", () => {
  it("escapes the term and declares the escape character", () => {
    const { sql, params } = compile(
      select(Post).where(contains(["title"], "100%")),
      "postgresql",
    );
    expect(sql).toContain(`"title" ILIKE $1 ESCAPE '\\'`);
    expect(params).toEqual(["%100\\%%"]);
  });

  it("uses LIKE with the same escape clause on SQLite", () => {
    const { sql, params } = compile(
      select(Post).where(contains(["title"], "100%")),
      "sqlite",
    );
    expect(sql).toContain(`"title" LIKE ? ESCAPE '\\'`);
    expect(params).toEqual(["%100\\%%"]);
  });

  it("requires every token, across all the columns", () => {
    const { sql, params } = compile(
      select(Post).where(contains(["title", "body"], "ana silva")),
      "postgresql",
    );
    expect(params).toEqual(["%ana%", "%ana%", "%silva%", "%silva%"]);
    expect(sql.match(/ILIKE/g)).toHaveLength(4);
  });

  it("rejects a call with no column", () => {
    expect(() => contains([], "x")).toThrow(/at least one column/);
  });
});

describe("fullText — compilation", () => {
  it("uses to_tsvector and websearch_to_tsquery on PostgreSQL", () => {
    const { sql, params } = compile(
      select(Post).where(
        fullText(["title", "body"], "comprou", { language: "portuguese" }),
      ),
      "postgresql",
    );
    expect(sql).toContain("to_tsvector($1::regconfig");
    expect(sql).toContain("coalesce(\"title\", '') || ' ' || coalesce(\"body\", '')");
    expect(sql).toContain("@@ websearch_to_tsquery($1::regconfig, $2)");
    expect(params).toEqual(["portuguese", "comprou"]);
  });

  it("falls back to the substring search on SQLite", () => {
    const { sql, params } = compile(
      select(Post).where(fullText(["title", "body"], "comprou")),
      "sqlite",
    );
    expect(sql).not.toContain("tsvector");
    expect(sql).toContain("LIKE ? ESCAPE");
    expect(params).toEqual(["%comprou%", "%comprou%"]);
  });

  it("ranks with ts_rank on PostgreSQL and inertly elsewhere", () => {
    const builder = select(Post)
      .where(fullText(["title"], "x"))
      .orderBy(fullTextRank(["title"], "x"), "desc");
    expect(compile(builder, "postgresql").sql).toContain("ORDER BY ts_rank(");
    expect(compile(builder, "sqlite").sql).toContain("ORDER BY 0 DESC");
  });
});

describe("contains — execution", () => {
  let engine: AsyncEngine;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL, []);
    await engine.session().execute(
      insert(Post).values([
        { id: 1, title: "Desconto de 100%", body: "tudo pela metade" },
        { id: 2, title: "Ana Silva", body: "perfil" },
        { id: 3, title: "Anacleto", body: "sobre a Ana" },
        { id: 4, title: "a_b", body: "underscore" },
      ]),
    );
  });

  it("matches a literal percent instead of every row", async () => {
    const rows = await engine
      .session()
      .execute(select(Post).where(contains(["title"], "100%")))
      .all();
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it("matches a literal underscore instead of any character", async () => {
    const rows = await engine
      .session()
      .execute(select(Post).where(contains(["title"], "a_b")))
      .all();
    expect(rows.map((r) => r.id)).toEqual([4]);
  });

  it("narrows as tokens are added, across columns", async () => {
    const one = await engine
      .session()
      .execute(
        select(Post)
          .where(contains(["title", "body"], "ana"))
          .orderBy("id"),
      )
      .all();
    expect(one.map((r) => r.id)).toEqual([2, 3]);

    const two = await engine
      .session()
      .execute(
        select(Post)
          .where(contains(["title", "body"], "ana silva"))
          .orderBy("id"),
      )
      .all();
    expect(two.map((r) => r.id)).toEqual([2]);
  });

  it("matches any token when asked", async () => {
    const rows = await engine
      .session()
      .execute(
        select(Post)
          .where(contains(["title", "body"], "silva underscore", { match: "any" }))
          .orderBy("id"),
      )
      .all();
    expect(rows.map((r) => r.id)).toEqual([2, 4]);
  });

  it("matches nothing for a blank term", async () => {
    const rows = await engine
      .session()
      .execute(select(Post).where(contains(["title"], "   ")))
      .all();
    expect(rows).toEqual([]);
  });
});
