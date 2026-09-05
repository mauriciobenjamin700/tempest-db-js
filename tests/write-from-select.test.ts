import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  Model,
  col,
  column,
  createEngine,
  del,
  getDialect,
  insert,
  select,
  update,
} from "../src/index.js";

class Order extends Model {
  static override tablename = "orders";
  id = column.integer().primaryKey();
  customerId = column.integer().notNull();
  total = column.integer().notNull();
  tier = column.varchar(20);
}

class ArchivedOrder extends Model {
  static override tablename = "archived_orders";
  id = column.integer().primaryKey();
  total = column.integer().notNull();
}

class Customer extends Model {
  static override tablename = "customers";
  id = column.integer().primaryKey();
  tier = column.varchar(20).notNull();
  banned = column.boolean().notNull();
}

const DDL = [
  "CREATE TABLE orders (id INTEGER PRIMARY KEY, customerId INTEGER NOT NULL, total INTEGER NOT NULL, tier TEXT)",
  "CREATE TABLE archived_orders (id INTEGER PRIMARY KEY, total INTEGER NOT NULL)",
  "CREATE TABLE customers (id INTEGER PRIMARY KEY, tier TEXT NOT NULL, banned INTEGER NOT NULL)",
];

function compile(builder: unknown, dialect: "sqlite" | "postgresql" | "mysql") {
  return getDialect(dialect).compile((builder as { node: never }).node);
}

describe("INSERT ... SELECT", () => {
  it("compiles to one statement", () => {
    const { sql, params } = compile(
      insert(ArchivedOrder).fromSelect(
        ["id", "total"],
        select(Order, ["id", "total"]).where({ total: { gt: 100 } }),
      ),
      "postgresql",
    );
    expect(sql).toBe(
      'INSERT INTO "archived_orders" ("id", "total") ' +
        'SELECT "id", "total" FROM "orders" WHERE "total" > $1',
    );
    expect(params).toEqual([100]);
  });

  it("keeps RETURNING", () => {
    const { sql } = compile(
      insert(ArchivedOrder)
        .fromSelect(["id", "total"], select(Order, ["id", "total"]))
        .returning(["id"]),
      "postgresql",
    );
    expect(sql.endsWith('RETURNING "id"')).toBe(true);
  });

  it("needs at least one target column", () => {
    expect(() =>
      insert(ArchivedOrder).fromSelect([], select(Order, ["id"]) as never),
    ).toThrow(/at least one target column/);
  });
});

describe("UPDATE ... FROM / DELETE ... USING — compilation", () => {
  const updateFrom = () =>
    update(Order)
      .set({ tier: col("c.tier") })
      .from(Customer, "c")
      .where({ customerId: col("c.id") });

  it("renders FROM on PostgreSQL and SQLite", () => {
    expect(compile(updateFrom(), "postgresql").sql).toBe(
      'UPDATE "orders" SET "tier" = "c"."tier" FROM "customers" AS "c" ' +
        'WHERE "customerId" = "c"."id"',
    );
    expect(compile(updateFrom(), "sqlite").sql).toContain('FROM "customers" AS "c"');
  });

  it("refuses a multi-table write on MySQL", () => {
    expect(() => compile(updateFrom(), "mysql")).toThrow(/out of scope/);
  });

  it("renders USING on PostgreSQL and refuses it elsewhere", () => {
    const builder = del(Order)
      .using(Customer, "c")
      .where({ customerId: col("c.id"), "c.banned": true } as never);
    expect(compile(builder, "postgresql").sql).toContain('USING "customers" AS "c"');
    expect(() => compile(builder, "sqlite")).toThrow(/no DELETE \.\.\. USING/);
    expect(() => compile(builder, "mysql")).toThrow(/out of scope/);
  });
});

describe("execution on SQLite", () => {
  let engine: AsyncEngine;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    for (const stmt of DDL) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
    await engine.session().execute(
      insert(Customer).values([
        { id: 1, tier: "gold", banned: false },
        { id: 2, tier: "silver", banned: true },
      ]),
    );
    await engine.session().execute(
      insert(Order).values([
        { id: 10, customerId: 1, total: 500 },
        { id: 11, customerId: 2, total: 50 },
        { id: 12, customerId: 1, total: 150 },
      ]),
    );
  });

  it("archives rows without bringing them through the process", async () => {
    const affected = await engine
      .session()
      .execute(
        insert(ArchivedOrder).fromSelect(
          ["id", "total"],
          select(Order, ["id", "total"]).where({ total: { gte: 150 } }),
        ),
      )
      .rowsAffected();
    expect(affected).toBe(2);

    const archived = await engine
      .session()
      .execute(select(ArchivedOrder).orderBy("id"))
      .all();
    expect(archived.map((r) => r.id)).toEqual([10, 12]);
  });

  it("updates from another table", async () => {
    await engine
      .session()
      .execute(
        update(Order)
          .set({ tier: col("c.tier") })
          .from(Customer, "c")
          .where({ customerId: col("c.id") }),
      )
      .rowsAffected();

    const rows = await engine.session().execute(select(Order).orderBy("id")).all();
    expect(rows.map((r) => r.tier)).toEqual(["gold", "silver", "gold"]);
  });
});
