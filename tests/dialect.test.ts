import { describe, expect, it } from "vitest";
import {
  Model,
  avg,
  column,
  count,
  del,
  getDialect,
  insert,
  max,
  select,
  sql,
  sum,
  update,
} from "../src/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.varchar(80).notNull();
  age = column.integer().notNull();
  active = column.boolean().notNull();
}

const sqlite = getDialect("sqlite");
const pg = getDialect("postgresql");

describe("SELECT compilation", () => {
  it("compiles a bare select", () => {
    expect(sqlite.compile(select(User).node)).toEqual({
      sql: 'SELECT * FROM "users"',
      params: [],
    });
  });

  it("compiles projection, where, order, limit, offset (SQLite)", () => {
    const q = select(User, ["id", "name"])
      .where({ age: { gte: 18 }, name: { like: "%a%" } })
      .orderBy("age", "desc")
      .limit(10)
      .offset(20);
    expect(sqlite.compile(q.node)).toEqual({
      sql: 'SELECT "id", "name" FROM "users" WHERE "age" >= ? AND "name" LIKE ? ORDER BY "age" DESC LIMIT ? OFFSET ?',
      params: [18, "%a%", 10, 20],
    });
  });

  it("uses $1 placeholders on PostgreSQL", () => {
    const q = select(User)
      .where({ age: { gt: 21 } })
      .limit(5);
    expect(pg.compile(q.node)).toEqual({
      sql: 'SELECT * FROM "users" WHERE "age" > $1 LIMIT $2',
      params: [21, 5],
    });
  });

  it("renders ilike natively on PG and as LIKE on SQLite", () => {
    const q = select(User).where({ name: { ilike: "%bEn%" } });
    expect(pg.compile(q.node).sql).toContain('"name" ILIKE $1');
    expect(sqlite.compile(q.node).sql).toContain('"name" LIKE ?');
  });

  it("compiles in, between, isNull, and bare equality", () => {
    expect(sqlite.compile(select(User).where({ id: { in: [1, 2, 3] } }).node)).toEqual({
      sql: 'SELECT * FROM "users" WHERE "id" IN (?, ?, ?)',
      params: [1, 2, 3],
    });
    expect(
      sqlite.compile(select(User).where({ age: { between: [18, 65] } }).node).sql,
    ).toContain('"age" BETWEEN ? AND ?');
    expect(
      sqlite.compile(select(User).where({ name: { isNull: true } }).node).sql,
    ).toContain('"name" IS NULL');
    expect(sqlite.compile(select(User).where({ id: 7 }).node)).toEqual({
      sql: 'SELECT * FROM "users" WHERE "id" = ?',
      params: [7],
    });
  });

  it("emits SELECT DISTINCT", () => {
    expect(sqlite.compile(select(User).distinct().node).sql).toBe(
      'SELECT DISTINCT * FROM "users"',
    );
    expect(
      sqlite.compile(select(User, ["age"]).distinct().where({ active: true }).node).sql,
    ).toBe('SELECT DISTINCT "age" FROM "users" WHERE "active" = ?');
  });

  it("renders empty IN / NOT IN safely", () => {
    expect(sqlite.compile(select(User).where({ id: { in: [] } }).node).sql).toContain(
      "1 = 0",
    );
    expect(sqlite.compile(select(User).where({ id: { notIn: [] } }).node).sql).toContain(
      "1 = 1",
    );
  });
});

describe("aggregate / GROUP BY compilation", () => {
  it("compiles grouped aggregates with aliases", () => {
    const q = select(User).aggregate(["active"], {
      n: count(),
      avgAge: avg("age"),
      oldest: max("age"),
    });
    expect(sqlite.compile(q.node).sql).toBe(
      'SELECT "active", COUNT(*) AS "n", AVG("age") AS "avgAge", MAX("age") AS "oldest" FROM "users" GROUP BY "active"',
    );
  });

  it("compiles a whole-table aggregate (no group by)", () => {
    const q = select(User).aggregate([], { total: count(), sumAge: sum("age") });
    expect(sqlite.compile(q.node).sql).toBe(
      'SELECT COUNT(*) AS "total", SUM("age") AS "sumAge" FROM "users"',
    );
  });

  it("keeps WHERE before GROUP BY", () => {
    const q = select(User).where({ active: true }).aggregate(["age"], { n: count() });
    expect(sqlite.compile(q.node).sql).toBe(
      'SELECT "age", COUNT(*) AS "n" FROM "users" WHERE "active" = ? GROUP BY "age"',
    );
  });
});

describe("INSERT compilation", () => {
  it("compiles a single row", () => {
    const q = insert(User).values({ name: "Ben", age: 30, active: true });
    expect(sqlite.compile(q.node)).toEqual({
      sql: 'INSERT INTO "users" ("name", "age", "active") VALUES (?, ?, ?)',
      params: ["Ben", 30, true],
    });
  });

  it("compiles multiple rows and RETURNING", () => {
    const q = insert(User)
      .values([
        { name: "A", age: 1, active: true },
        { name: "B", age: 2, active: false },
      ])
      .returning(["id"]);
    expect(pg.compile(q.node)).toEqual({
      sql: 'INSERT INTO "users" ("name", "age", "active") VALUES ($1, $2, $3), ($4, $5, $6) RETURNING "id"',
      params: ["A", 1, true, "B", 2, false],
    });
  });

  it("reuses the SQL template across same-shape inserts, with per-row params", () => {
    // The template cache keys on structure, so two different-value inserts of the
    // same shape yield identical SQL but their own params.
    const a = sqlite.compile(
      insert(User).values({ name: "A", age: 1, active: true }).node,
    );
    const b = sqlite.compile(
      insert(User).values({ name: "B", age: 2, active: false }).node,
    );
    expect(a.sql).toBe(b.sql);
    expect(a.params).toEqual(["A", 1, true]);
    expect(b.params).toEqual(["B", 2, false]);
  });

  it("compiles ON CONFLICT DO NOTHING", () => {
    const q = insert(User)
      .values({ name: "Ben", age: 30, active: true })
      .onConflictDoNothing(["name"]);
    expect(sqlite.compile(q.node)).toEqual({
      sql: 'INSERT INTO "users" ("name", "age", "active") VALUES (?, ?, ?) ON CONFLICT ("name") DO NOTHING',
      params: ["Ben", 30, true],
    });
  });

  it("compiles ON CONFLICT DO UPDATE (upsert), binding SET values last", () => {
    const q = insert(User)
      .values({ name: "Ben", age: 30, active: true })
      .onConflictDoUpdate(["name"], { age: 31, active: false })
      .returning(["id"]);
    expect(pg.compile(q.node)).toEqual({
      sql: 'INSERT INTO "users" ("name", "age", "active") VALUES ($1, $2, $3) ON CONFLICT ("name") DO UPDATE SET "age" = $4, "active" = $5 RETURNING "id"',
      params: ["Ben", 30, true, 31, false],
    });
  });

  it("binds a null value as a placeholder (not IS NULL) in INSERT", () => {
    class Note extends Model {
      static override tablename = "notes";
      id = column.integer().primaryKey();
      body = column.text(); // nullable
    }
    const q = insert(Note).values({ body: null });
    expect(sqlite.compile(q.node)).toEqual({
      sql: 'INSERT INTO "notes" ("body") VALUES (?)',
      params: [null],
    });
  });
});

describe("UPDATE / DELETE compilation", () => {
  it("compiles update with set + where + returning *", () => {
    const q = update(User).set({ age: 31 }).where({ id: 1 }).returning();
    expect(sqlite.compile(q.node)).toEqual({
      sql: 'UPDATE "users" SET "age" = ? WHERE "id" = ? RETURNING *',
      params: [31, 1],
    });
  });

  it("compiles delete with where", () => {
    const q = del(User).where({ active: false });
    expect(pg.compile(q.node)).toEqual({
      sql: 'DELETE FROM "users" WHERE "active" = $1',
      params: [false],
    });
  });

  it("keeps placeholder ordering across SET then WHERE on PG", () => {
    const q = update(User).set({ name: "x", age: 9 }).where({ id: 5 });
    expect(pg.compile(q.node)).toEqual({
      sql: 'UPDATE "users" SET "name" = $1, "age" = $2 WHERE "id" = $3',
      params: ["x", 9, 5],
    });
  });
});

describe("server-side default expressions are bound as values (Phase 4a)", () => {
  it("binds a literal default value path through insert params", () => {
    // sql.* expressions live on the column; the builder still binds explicit values.
    const q = insert(User).values({ name: "x", age: 1, active: true });
    expect(sqlite.compile(q.node).params).toEqual(["x", 1, true]);
    // sanity: sql.now() is a marker object, not executed here
    expect(sql.now()).toEqual({ kind: "expression", expression: "now" });
  });
});
