import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  Model,
  caseWhen,
  cast,
  col,
  column,
  createEngine,
  getDialect,
  insert,
  select,
  sum,
  val,
} from "../src/index.js";

class Order extends Model {
  static override tablename = "orders";
  id = column.integer().primaryKey();
  customer = column.varchar(40).notNull();
  status = column.varchar(20).notNull();
  total = column.integer().notNull();
  externalId = column.varchar(20).notNull();
}

const DDL = `CREATE TABLE orders (
  id INTEGER PRIMARY KEY, customer TEXT NOT NULL, status TEXT NOT NULL,
  total INTEGER NOT NULL, externalId TEXT NOT NULL)`;

describe("CASE / CAST — compilation", () => {
  it("renders a conditional aggregate", () => {
    const q = select(Order).aggregate(["customer"], {
      paid: sum(caseWhen([[{ status: "paid" }, col("total")]], val(0))),
    });
    const { sql, params } = getDialect("postgresql").compile(
      (q as unknown as { node: never }).node,
    );
    expect(sql).toContain(
      'SUM(CASE WHEN "status" = $1 THEN "total" ELSE $2 END) AS "paid"',
    );
    expect(params).toEqual(["paid", 0]);
  });

  it("renders a multi-branch CASE with no ELSE", () => {
    const q = select(Order).where(
      caseWhen([
        [{ status: "paid" }, val(1)],
        [{ status: "open" }, val(2)],
      ]).eq(1),
    );
    const { sql } = getDialect("sqlite").compile((q as unknown as { node: never }).node);
    expect(sql).toContain(
      'CASE WHEN "status" = ? THEN ? WHEN "status" = ? THEN ? END = ?',
    );
  });

  it("maps the cast target per dialect", () => {
    const q = select(Order).where(cast("externalId", "integer").eq(42));
    const of = (d: "sqlite" | "postgresql" | "mysql") =>
      getDialect(d).compile((q as unknown as { node: never }).node).sql;
    expect(of("postgresql")).toContain('CAST("externalId" AS INTEGER)');
    expect(of("sqlite")).toContain('CAST("externalId" AS INTEGER)');
    expect(of("mysql")).toContain("CAST(`externalId` AS SIGNED)");

    const text = select(Order).where(cast("total", "text").eq("42"));
    const textOf = (d: "sqlite" | "postgresql" | "mysql") =>
      getDialect(d).compile((text as unknown as { node: never }).node).sql;
    expect(textOf("postgresql")).toContain("AS TEXT)");
    expect(textOf("sqlite")).toContain("AS TEXT)");
    expect(textOf("mysql")).toContain("AS CHAR)");
  });

  it("rejects a CASE with no branch", () => {
    expect(() => caseWhen([])).toThrow(/at least one/);
  });
});

describe("CASE / CAST — execution", () => {
  let engine: AsyncEngine;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL, []);
    await engine.session().execute(
      insert(Order).values([
        { id: 1, customer: "ana", status: "paid", total: 100, externalId: "10" },
        { id: 2, customer: "ana", status: "open", total: 50, externalId: "20" },
        { id: 3, customer: "beto", status: "paid", total: 70, externalId: "5" },
      ]),
    );
  });

  it("sums only the matching rows, in one pass", async () => {
    const rows = await engine
      .session()
      .execute(
        select(Order)
          .aggregate(["customer"], {
            paid: sum(caseWhen([[{ status: "paid" }, col("total")]], val(0))),
            all: sum("total"),
          })
          .orderBy("customer"),
      )
      .all();
    expect(rows).toEqual([
      { customer: "ana", paid: 100, all: 150 },
      { customer: "beto", paid: 70, all: 70 },
    ]);
  });

  it("compares a cast column against a number", async () => {
    const rows = await engine
      .session()
      .execute(select(Order).where(cast("externalId", "integer").gt(9)).orderBy("id"))
      .all();
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });
});
