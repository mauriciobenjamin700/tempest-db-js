import { beforeEach, describe, expect, it } from "vitest";
import {
  type InferModel,
  Model,
  type SyncEngine,
  and,
  column,
  createSyncEngine,
  del,
  getDialect,
  insert,
  not,
  or,
  select,
} from "../src/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.varchar(80).notNull();
  age = column.integer().notNull();
  active = column.boolean().notNull();
}

type UserRow = InferModel<typeof User>;
const sqlite = getDialect("sqlite");

describe("and/or/not — SQL compilation", () => {
  it("compiles OR with parenthesized parts", () => {
    const q = select(User).where(or({ age: { lt: 18 } }, { age: { gt: 65 } }));
    expect(sqlite.compile(q.node)).toEqual({
      sql: 'SELECT * FROM "users" WHERE ("age" < ?) OR ("age" > ?)',
      params: [18, 65],
    });
  });

  it("compiles AND of conditions", () => {
    const q = select(User).where(and({ active: true }, { age: { gte: 18 } }));
    expect(sqlite.compile(q.node).sql).toBe(
      'SELECT * FROM "users" WHERE ("active" = ?) AND ("age" >= ?)',
    );
  });

  it("compiles NOT", () => {
    const q = select(User).where(not({ active: true }));
    expect(sqlite.compile(q.node).sql).toBe(
      'SELECT * FROM "users" WHERE NOT ("active" = ?)',
    );
  });

  it("nests combinators", () => {
    const q = select(User).where(
      and({ active: true }, or({ age: { lt: 18 } }, { age: { gt: 65 } })),
    );
    expect(sqlite.compile(q.node).sql).toBe(
      'SELECT * FROM "users" WHERE ("active" = ?) AND (("age" < ?) OR ("age" > ?))',
    );
  });

  it("the bare object form still compiles unchanged (implicit AND)", () => {
    const q = select(User).where({ active: true, age: { gte: 18 } });
    expect(sqlite.compile(q.node).sql).toBe(
      'SELECT * FROM "users" WHERE "active" = ? AND "age" >= ?',
    );
  });
});

describe("and/or/not — real SQLite", () => {
  let engine: SyncEngine;
  beforeEach(() => {
    engine = createSyncEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    (engine as any).driver.execute(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL, active INTEGER NOT NULL)",
      [],
    );
    engine.session().execute(
      insert(User).values([
        { id: 1, name: "Kid", age: 12, active: true },
        { id: 2, name: "Adult", age: 30, active: true },
        { id: 3, name: "Senior", age: 70, active: false },
      ]),
    );
  });

  it("OR selects matching either branch", () => {
    const rows = engine
      .session()
      .execute(
        select(User)
          .where(or({ age: { lt: 18 } }, { age: { gt: 65 } }))
          .orderBy("id"),
      )
      .all() as UserRow[];
    expect(rows.map((r) => r.name)).toEqual(["Kid", "Senior"]);
  });

  it("AND + NOT compose", () => {
    const rows = engine
      .session()
      .execute(select(User).where(and({ active: true }, not({ age: { lt: 18 } }))))
      .all() as UserRow[];
    expect(rows.map((r) => r.name)).toEqual(["Adult"]);
  });

  it("works in delete too", () => {
    const s = engine.session();
    const removed = s
      .execute(del(User).where(or({ age: { lt: 18 } }, { age: { gt: 65 } })))
      .rowsAffected();
    expect(removed).toBe(2);
    expect(s.execute(select(User)).all()).toHaveLength(1);
  });
});
