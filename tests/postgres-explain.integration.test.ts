/**
 * PostgreSQL integration for `engine.explain` — the JSON plan shape, and
 * `ANALYZE`, neither of which SQLite has.
 *
 * Gated on `TEST_DATABASE_URL`; uses its own table so it can run in parallel with
 * the other integration files.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AsyncDriver,
  type AsyncEngine,
  BaseRepository,
  Model,
  column,
  createEngine,
  select,
} from "../src/index.js";
import { reflectTable, renderOperation } from "../src/migrations/index.js";

const url = process.env.TEST_DATABASE_URL;

class PlanRow extends Model {
  static override tablename = "plan_rows";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  label = column.text().notNull();
}

describe.skipIf(!url)("PostgreSQL — explain", () => {
  let engine: AsyncEngine;
  let driver: AsyncDriver;

  beforeAll(async () => {
    engine = createEngine(url as string);
    driver = (engine as unknown as { driver: AsyncDriver }).driver;
    await driver.execute("DROP TABLE IF EXISTS plan_rows CASCADE", []);
    for (const stmt of renderOperation(
      { kind: "create_table", table: reflectTable(PlanRow) },
      "postgresql",
    )) {
      await driver.execute(stmt, []);
    }
    await new BaseRepository(PlanRow, engine.session()).createMany(
      Array.from({ length: 50 }, (_, i) => ({ id: i + 1, label: `row ${i}` })),
    );
  });

  afterAll(async () => {
    await driver.execute("DROP TABLE IF EXISTS plan_rows CASCADE", []);
    await engine.close();
  });

  it("returns a JSON plan naming the scan and the relation", async () => {
    const report = await engine.explain(async (session) => {
      await session.execute(select(PlanRow).where({ id: 1 })).all();
    });
    expect(report.plans).toHaveLength(1);
    expect(report.plans[0]?.summary()).toMatch(/scan/i);
    expect(report.plans[0]?.summary()).toContain("plan_rows");
  });

  it("measures with ANALYZE when asked", async () => {
    const report = await engine.explain(
      async (session) => {
        await session.execute(select(PlanRow)).all();
      },
      { analyze: true },
    );
    const plan = report.plans[0]?.plan as { Plan?: Record<string, unknown> };
    expect(plan?.Plan?.["Actual Rows"]).toBeGreaterThan(0);
  });

  it("refuses ANALYZE for a write, which it would apply twice", async () => {
    await expect(
      engine.explain(
        async (session) => {
          await new BaseRepository(PlanRow, session).create({ id: 999, label: "x" });
        },
        { analyze: true },
      ),
    ).rejects.toThrow(/refused for a write/);
    expect(
      await new BaseRepository(PlanRow, engine.session()).getByIdOrNull(999),
    ).not.toBeNull();
    await new BaseRepository(PlanRow, engine.session()).delete({ id: 999 });
  });
});
