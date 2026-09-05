import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  Model,
  column,
  createEngine,
  denseRank,
  getDialect,
  insert,
  lag,
  over,
  rank,
  rowNumber,
  select,
  sum,
} from "../src/index.js";

class Sale extends Model {
  static override tablename = "sales";
  id = column.integer().primaryKey();
  region = column.varchar(20).notNull();
  day = column.integer().notNull();
  total = column.integer().notNull();
}

const DDL =
  "CREATE TABLE sales (id INTEGER PRIMARY KEY, region TEXT NOT NULL, day INTEGER NOT NULL, total INTEGER NOT NULL)";

function compile(builder: unknown, dialect: "sqlite" | "postgresql" | "mysql") {
  return getDialect(dialect).compile((builder as { node: never }).node);
}

describe("window functions — compilation", () => {
  it("renders PARTITION BY, ORDER BY and the alias", () => {
    const { sql } = compile(
      select(Sale).compute({
        position: over(rowNumber(), {
          partitionBy: ["region"],
          orderBy: [["total", "desc"]],
        }),
      }),
      "postgresql",
    );
    expect(sql).toContain(
      'row_number() OVER (PARTITION BY "region" ORDER BY "total" DESC) AS "position"',
    );
  });

  it("windows an aggregate", () => {
    const { sql } = compile(
      select(Sale).compute({ running: over(sum("total"), { orderBy: ["day"] }) }),
      "sqlite",
    );
    expect(sql).toContain('sum("total") OVER (ORDER BY "day" ASC) AS "running"');
  });

  it("emits an explicit frame when given one", () => {
    const { sql } = compile(
      select(Sale).compute({
        running: over(sum("total"), {
          orderBy: ["day"],
          frame: "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW",
        }),
      }),
      "postgresql",
    );
    expect(sql).toContain("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)");
  });

  it("keeps the projected columns alongside the computed ones", () => {
    const { sql } = compile(
      select(Sale, ["id"]).compute({ n: over(rowNumber(), {}) }),
      "sqlite",
    );
    expect(sql).toBe('SELECT "id", row_number() OVER () AS "n" FROM "sales"');
  });
});

describe("window functions — execution", () => {
  let engine: AsyncEngine;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL, []);
    await engine.session().execute(
      insert(Sale).values([
        { id: 1, region: "south", day: 1, total: 10 },
        { id: 2, region: "south", day: 2, total: 30 },
        { id: 3, region: "south", day: 3, total: 20 },
        { id: 4, region: "north", day: 1, total: 50 },
        { id: 5, region: "north", day: 2, total: 50 },
      ]),
    );
  });

  it("ranks within each partition", async () => {
    const rows = await engine
      .session()
      .execute(
        select(Sale, ["id", "region"])
          .compute({
            position: over(rowNumber(), {
              partitionBy: ["region"],
              orderBy: [["total", "desc"]],
            }),
          })
          .orderBy("id"),
      )
      .all();
    expect(rows.map((r) => [r.id, r.position])).toEqual([
      [1, 3],
      [2, 1],
      [3, 2],
      [4, 1],
      [5, 2],
    ]);
  });

  it("computes a running total with an explicit ROWS frame", async () => {
    const rows = await engine
      .session()
      .execute(
        select(Sale, ["id"])
          .compute({
            running: over(sum("total"), {
              partitionBy: ["region"],
              orderBy: ["day"],
              frame: "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW",
            }),
          })
          .orderBy("id"),
      )
      .all();
    expect(rows.slice(0, 3).map((r) => r.running)).toEqual([10, 40, 60]);
  });

  it("rank ties share a position and skip, dense_rank does not", async () => {
    const rows = await engine
      .session()
      .execute(
        select(Sale, ["id"])
          .compute({
            r: over(rank(), { orderBy: [["total", "desc"]] }),
            d: over(denseRank(), { orderBy: [["total", "desc"]] }),
          })
          .orderBy("id"),
      )
      .all();
    const byId = new Map(rows.map((r) => [r.id, [r.r, r.d]]));
    expect(byId.get(4)).toEqual([1, 1]);
    expect(byId.get(5)).toEqual([1, 1]);
    expect(byId.get(2)).toEqual([3, 2]);
  });

  it("reads the previous row with lag, which needs its window", async () => {
    const rows = await engine
      .session()
      .execute(
        select(Sale, ["id"])
          .compute({
            previous: over(lag<number>("total"), { orderBy: ["id"] }),
          })
          .orderBy("id"),
      )
      .all();
    expect(rows.map((r) => r.previous)).toEqual([null, 10, 30, 20, 50]);
  });

  it("supports top-N per group by filtering on the rank", async () => {
    const ranked = await engine
      .session()
      .execute(
        select(Sale, ["id", "region"]).compute({
          position: over(rowNumber(), {
            partitionBy: ["region"],
            orderBy: [["total", "desc"]],
          }),
        }),
      )
      .all();
    const top = ranked.filter((r) => r.position === 1).map((r) => r.id);
    expect(top.sort()).toEqual([2, 4]);
  });
});

describe("window functions — types", () => {
  it("refuses a window function used without OVER", () => {
    // @ts-expect-error — lag() is a WindowFn, not an Expression: it needs over().
    select(Sale).compute({ previous: lag<number>("total") });
  });
});
