import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  Model,
  column,
  createEngine,
  cte,
  cteRecursive,
  getDialect,
  insert,
  join,
  select,
  unionAll,
} from "../src/index.js";

class Category extends Model {
  static override tablename = "categories";
  id = column.integer().primaryKey();
  parentId = column.integer();
  name = column.varchar(40).notNull();
}

const DDL =
  "CREATE TABLE categories (id INTEGER PRIMARY KEY, parentId INTEGER, name TEXT NOT NULL)";

function compile(builder: unknown, dialect: "sqlite" | "postgresql" | "mysql") {
  return getDialect(dialect).compile((builder as { node: never }).node);
}

describe("CTE — compilation", () => {
  it("emits WITH before the outer SELECT", () => {
    const recent = cte("recent", Category, select(Category).where({ parentId: null }));
    const { sql } = compile(recent.select().where({ name: "raiz" }), "postgresql");
    expect(sql).toBe(
      'WITH "recent" AS (SELECT * FROM "categories" WHERE "parentId" IS NULL) ' +
        'SELECT * FROM "recent" WHERE "name" = $1',
    );
  });

  it("emits WITH RECURSIVE when the body refers to itself", () => {
    const subtree = cteRecursive("subtree", Category, (self) =>
      unionAll(
        select(Category).where({ id: 1 }),
        join(Category, "c").innerJoin(self, "s", { "c.parentId": "s.id" }).pick("c"),
      ),
    );
    const { sql } = compile(subtree.select(), "sqlite");
    expect(sql.startsWith('WITH RECURSIVE "subtree" AS (')).toBe(true);
    expect(sql).toContain('JOIN "subtree" AS "s"');
    expect(sql.endsWith('SELECT * FROM "subtree"')).toBe(true);
  });

  it("passes the materialization hint through when asked", () => {
    const body = select(Category);
    expect(
      compile(cte("c", Category, body, { materialized: true }).select(), "postgresql")
        .sql,
    ).toContain('"c" AS MATERIALIZED (');
    expect(
      compile(cte("c", Category, body, { materialized: false }).select(), "postgresql")
        .sql,
    ).toContain('"c" AS NOT MATERIALIZED (');
    expect(compile(cte("c", Category, body).select(), "postgresql").sql).toContain(
      '"c" AS (',
    );
  });
});

describe("CTE — execution", () => {
  let engine: AsyncEngine;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL, []);
    await engine.session().execute(
      insert(Category).values([
        { id: 1, parentId: null, name: "raiz" },
        { id: 2, parentId: 1, name: "filho a" },
        { id: 3, parentId: 1, name: "filho b" },
        { id: 4, parentId: 2, name: "neto" },
        { id: 5, parentId: null, name: "outra raiz" },
        { id: 6, parentId: 5, name: "fora da subarvore" },
      ]),
    );
  });

  it("selects from a named query", async () => {
    const roots = cte("roots", Category, select(Category).where({ parentId: null }));
    const rows = await engine.session().execute(roots.select().orderBy("id")).all();
    expect(rows.map((r) => r.id)).toEqual([1, 5]);
  });

  it("walks a tree three levels deep in one statement", async () => {
    const subtree = cteRecursive("subtree", Category, (self) =>
      unionAll(
        select(Category).where({ id: 1 }),
        join(Category, "c").innerJoin(self, "s", { "c.parentId": "s.id" }).pick("c"),
      ),
    );
    const rows = await engine.session().execute(subtree.select().orderBy("id")).all();
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });

  it("keeps the outer filters separate from the body", async () => {
    const subtree = cteRecursive("subtree", Category, (self) =>
      unionAll(
        select(Category).where({ id: 1 }),
        join(Category, "c").innerJoin(self, "s", { "c.parentId": "s.id" }).pick("c"),
      ),
    );
    const rows = await engine
      .session()
      .execute(subtree.select().where({ parentId: 1 }).orderBy("id"))
      .all();
    expect(rows.map((r) => r.id)).toEqual([2, 3]);
  });
});
