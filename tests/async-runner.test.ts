import { describe, expect, it } from "vitest";
import { Model, column, createEngine, insert, select } from "../src/index.js";
import {
  AsyncMigrationRunner,
  type Migration,
  reflectTable,
} from "../src/migrations/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
}

function migration(): Migration {
  const table = reflectTable(User);
  return {
    revision: "001",
    downRevision: [],
    label: "create users",
    up: (op) => op.createTable(table),
    down: (op) => op.dropTable(table),
  };
}

describe("AsyncMigrationRunner — real async execution (SQLite wrapped as async)", () => {
  it("upgrade applies, applied() reflects it, downgrade reverts", async () => {
    const engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: reach the async driver for the runner.
    const driver = (engine as any).driver;
    const runner = new AsyncMigrationRunner(driver, "sqlite");

    expect([...(await runner.applied())]).toEqual([]);

    const ran = await runner.upgrade([migration()], "2026-07-01T00:00:00.000Z");
    expect(ran).toEqual(["001"]);
    expect([...(await runner.applied())]).toEqual(["001"]);

    // Table exists → an insert + select works.
    const s = engine.session();
    await s.execute(insert(User).values({ id: 1, name: "Ana" }));
    const row = (await s.execute(select(User).where({ id: 1 })).first()) as {
      name: string;
    };
    expect(row.name).toBe("Ana");

    const reverted = await runner.downgrade([migration()]);
    expect(reverted).toEqual(["001"]);
    expect([...(await runner.applied())]).toEqual([]);
    await engine.close();
  });

  it("upgrade is idempotent — re-running applies nothing", async () => {
    const engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access.
    const driver = (engine as any).driver;
    const runner = new AsyncMigrationRunner(driver, "sqlite");
    await runner.upgrade([migration()], "t");
    const second = await runner.upgrade([migration()], "t");
    expect(second).toEqual([]);
    await engine.close();
  });
});
