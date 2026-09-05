import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  Model,
  col,
  column,
  createEngine,
  exists,
  getDialect,
  insert,
  notExists,
  scalar,
  select,
} from "../src/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.varchar(40).notNull();
}

class Order extends Model {
  static override tablename = "orders";
  id = column.integer().primaryKey();
  userId = column.integer().notNull();
  total = column.integer().notNull();
  status = column.varchar(20).notNull();
}

const DDL = [
  "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
  "CREATE TABLE orders (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL)",
];

function compile(builder: unknown, dialect: "sqlite" | "postgresql" | "mysql") {
  return getDialect(dialect).compile((builder as { node: never }).node);
}

describe("EXISTS / NOT EXISTS — compilation", () => {
  it("renders a correlated EXISTS, qualifying the outer column", () => {
    const { sql, params } = compile(
      select(User).where(
        exists(select(Order).where({ userId: col("users.id"), status: "open" })),
      ),
      "postgresql",
    );
    expect(sql).toContain('EXISTS (SELECT * FROM "orders"');
    expect(sql).toContain('"userId" = "users"."id"');
    expect(params).toEqual(["open"]);
  });

  it("renders NOT EXISTS", () => {
    const { sql } = compile(
      select(User).where(notExists(select(Order).where({ userId: col("users.id") }))),
      "sqlite",
    );
    expect(sql).toContain('NOT EXISTS (SELECT * FROM "orders"');
  });

  it("accepts a narrowed subquery too", () => {
    const { sql } = compile(
      select(User).where(exists(select(Order, ["id"]).asSubquery("id"))),
      "sqlite",
    );
    expect(sql).toContain('EXISTS (SELECT "id" FROM "orders")');
  });
});

describe("scalar subquery — compilation", () => {
  it("embeds the SELECT where a value goes", () => {
    const latest = select(Order, ["total"])
      .where({ userId: col("users.id") })
      .orderBy("id", "desc")
      .limit(1)
      .asSubquery("total");
    const { sql } = compile(select(User).where(scalar(latest).gt(100)), "postgresql");
    expect(sql).toContain('(SELECT "total" FROM "orders" WHERE "userId" = "users"."id"');
    expect(sql).toContain('ORDER BY "id" DESC LIMIT $1) > $2');
  });
});

describe("EXISTS / scalar — execution", () => {
  let engine: AsyncEngine;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    for (const stmt of DDL) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
    await engine.session().execute(
      insert(User).values([
        { id: 1, name: "com pedido" },
        { id: 2, name: "sem pedido" },
        { id: 3, name: "pedido fechado" },
      ]),
    );
    await engine.session().execute(
      insert(Order).values([
        { id: 10, userId: 1, total: 150, status: "open" },
        { id: 11, userId: 1, total: 50, status: "open" },
        { id: 12, userId: 3, total: 999, status: "closed" },
      ]),
    );
  });

  it("finds only the users that have a matching order", async () => {
    const rows = await engine
      .session()
      .execute(
        select(User)
          .where(exists(select(Order).where({ userId: col("users.id"), status: "open" })))
          .orderBy("id"),
      )
      .all();
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it("NOT EXISTS finds the complement", async () => {
    const rows = await engine
      .session()
      .execute(
        select(User)
          .where(
            notExists(select(Order).where({ userId: col("users.id"), status: "open" })),
          )
          .orderBy("id"),
      )
      .all();
    expect(rows.map((r) => r.id)).toEqual([2, 3]);
  });

  it("compares against a scalar subquery", async () => {
    const biggest = select(Order, ["total"])
      .where({ userId: col("users.id") })
      .orderBy("total", "desc")
      .limit(1)
      .asSubquery("total");

    const rows = await engine
      .session()
      .execute(select(User).where(scalar(biggest).gt(100)).orderBy("id"))
      .all();
    expect(rows.map((r) => r.id)).toEqual([1, 3]);
  });
});
