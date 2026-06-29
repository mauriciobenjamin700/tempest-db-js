import { describe, expect, it } from "vitest";
import { Model, NodeSqliteDriver, column } from "../src/index.js";
import {
  type Migration,
  reflectTable,
  runMigrationCli,
} from "../src/migrations/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.varchar(80).notNull();
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

function config(driver: NodeSqliteDriver) {
  return {
    driver,
    dialect: "sqlite" as const,
    migrations: [migration()],
    models: [User],
    appliedAt: "2026-06-29T00:00:00.000Z",
  };
}

describe("migration CLI", () => {
  it("upgrade applies, current/history reflect it, downgrade reverts", () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const cfg = config(driver);

    expect(runMigrationCli(["current"], cfg).lines).toEqual(["(no migrations applied)"]);

    const up = runMigrationCli(["upgrade"], cfg);
    expect(up.code).toBe(0);
    expect(up.lines).toEqual(["applied 001"]);

    expect(runMigrationCli(["current"], cfg).lines).toEqual(["001"]);
    expect(runMigrationCli(["heads"], cfg).lines).toEqual(["001"]);
    expect(runMigrationCli(["history"], cfg).lines[0]).toContain("✓ 001");

    const down = runMigrationCli(["downgrade"], cfg);
    expect(down.lines).toEqual(["reverted 001"]);
    expect(runMigrationCli(["current"], cfg).lines).toEqual(["(no migrations applied)"]);
    driver.close();
  });

  it("upgrade --sql prints SQL without executing", () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const res = runMigrationCli(["upgrade", "--sql"], config(driver));
    expect(res.lines.some((l) => l.startsWith('CREATE TABLE "users"'))).toBe(true);
    // not executed → table absent
    expect(() => driver.execute('SELECT * FROM "users"', [])).toThrow();
    driver.close();
  });

  it("check passes when DB + models + migrations agree", () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const cfg = config(driver);
    runMigrationCli(["upgrade"], cfg);
    const res = runMigrationCli(["check"], cfg);
    expect(res.code).toBe(0);
  });

  it("check fails when a model change is not captured by a migration", () => {
    const driver = NodeSqliteDriver.open(":memory:");
    class UserV2 extends Model {
      static override tablename = "users";
      id = column.integer().primaryKey();
      name = column.varchar(80).notNull();
      email = column.varchar(120);
    }
    const cfg = {
      driver,
      dialect: "sqlite" as const,
      migrations: [migration()],
      models: [UserV2],
      appliedAt: "x",
    };
    runMigrationCli(["upgrade"], cfg);
    const res = runMigrationCli(["check"], cfg);
    expect(res.code).toBe(1);
    expect(res.lines.some((l) => l.includes("uncaptured") || l.includes("drift"))).toBe(
      true,
    );
    driver.close();
  });

  it("revision --autogenerate emits a migration file from the model diff", () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const cfg = { driver, dialect: "sqlite" as const, migrations: [], models: [User] };
    const res = runMigrationCli(["revision", "-m", "init", "--autogenerate"], cfg);
    const src = res.lines.join("\n");
    expect(src).toContain("export const up");
    expect(src).toContain("create_table");
    expect(src).toContain('"users"');
    driver.close();
  });

  it("unknown command fails with usage", () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const res = runMigrationCli(["bogus"], config(driver));
    expect(res.code).toBe(1);
    driver.close();
  });
});
