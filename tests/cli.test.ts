import { describe, expect, it } from "vitest";
import { type AsyncDriver, Model, NodeSqliteDriver, column } from "../src/index.js";
import {
  type CliConfig,
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
  it("upgrade applies, current/history reflect it, downgrade reverts", async () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const cfg = config(driver);

    expect((await runMigrationCli(["current"], cfg)).lines).toEqual([
      "(no migrations applied)",
    ]);

    const up = await runMigrationCli(["upgrade"], cfg);
    expect(up.code).toBe(0);
    expect(up.lines).toEqual(["applied 001"]);

    expect((await runMigrationCli(["current"], cfg)).lines).toEqual(["001"]);
    expect((await runMigrationCli(["heads"], cfg)).lines).toEqual(["001"]);
    expect((await runMigrationCli(["history"], cfg)).lines[0]).toContain("✓ 001");

    const down = await runMigrationCli(["downgrade"], cfg);
    expect(down.lines).toEqual(["reverted 001"]);
    expect((await runMigrationCli(["current"], cfg)).lines).toEqual([
      "(no migrations applied)",
    ]);
    driver.close();
  });

  it("upgrade --sql prints SQL without executing", async () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const res = await runMigrationCli(["upgrade", "--sql"], config(driver));
    expect(res.lines.some((l) => l.startsWith('CREATE TABLE "users"'))).toBe(true);
    // not executed → table absent
    expect(() => driver.execute('SELECT * FROM "users"', [])).toThrow();
    driver.close();
  });

  it("check passes when DB + models + migrations agree", async () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const cfg = config(driver);
    await runMigrationCli(["upgrade"], cfg);
    const res = await runMigrationCli(["check"], cfg);
    expect(res.code).toBe(0);
  });

  it("check fails when a model change is not captured by a migration", async () => {
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
    await runMigrationCli(["upgrade"], cfg);
    const res = await runMigrationCli(["check"], cfg);
    expect(res.code).toBe(1);
    expect(res.lines.some((l) => l.includes("uncaptured") || l.includes("drift"))).toBe(
      true,
    );
    driver.close();
  });

  it("revision --autogenerate emits a migration file from the model diff", async () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const cfg = { driver, dialect: "sqlite" as const, migrations: [], models: [User] };
    const res = await runMigrationCli(["revision", "-m", "init", "--autogenerate"], cfg);
    const src = res.lines.join("\n");
    expect(src).toContain("export const up");
    expect(src).toContain("create_table");
    expect(src).toContain('"users"');
    driver.close();
  });

  it("revision --autorename folds a column drop+add into a rename", async () => {
    const driver = NodeSqliteDriver.open(":memory:");
    // Baseline migration creates users(id, name); the model renames name → fullName.
    class UserRenamed extends Model {
      static override tablename = "users";
      id = column.integer().primaryKey();
      fullName = column.varchar(80).notNull();
    }
    const cfg = {
      driver,
      dialect: "sqlite" as const,
      migrations: [migration()],
      models: [UserRenamed],
    };
    const auto = (
      await runMigrationCli(
        ["revision", "-m", "rename", "--autogenerate", "--autorename"],
        cfg,
      )
    ).lines.join("\n");
    expect(auto).toContain("rename_column");
    expect(auto).not.toContain("drop_column");

    // Without --autorename the safe drop + add is emitted instead.
    const safe = (
      await runMigrationCli(["revision", "-m", "rename", "--autogenerate"], cfg)
    ).lines.join("\n");
    expect(safe).toContain("drop_column");
    expect(safe).not.toContain("rename_column");
    driver.close();
  });

  it("revision --rename-column folds only the specified rename", async () => {
    const driver = NodeSqliteDriver.open(":memory:");
    class UserRenamed extends Model {
      static override tablename = "users";
      id = column.integer().primaryKey();
      fullName = column.varchar(80).notNull();
    }
    const cfg = {
      driver,
      dialect: "sqlite" as const,
      migrations: [migration()],
      models: [UserRenamed],
    };
    const out = (
      await runMigrationCli(
        [
          "revision",
          "-m",
          "rename",
          "--autogenerate",
          "--rename-column",
          "users.name:fullName",
        ],
        cfg,
      )
    ).lines.join("\n");
    expect(out).toContain("rename_column");
    driver.close();
  });

  it("unknown command fails with usage", async () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const res = await runMigrationCli(["bogus"], config(driver));
    expect(res.code).toBe(1);
    driver.close();
  });
});

describe("CLI over an async driver", () => {
  /** Wrap the sync SQLite driver as async, standing in for a Postgres driver. */
  function asyncDriver(driver: NodeSqliteDriver): AsyncDriver {
    return {
      async execute(sql, params) {
        return driver.execute(sql, params);
      },
      async close() {
        driver.close();
      },
    };
  }

  it("runs the full upgrade/current/downgrade cycle", async () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const cfg: CliConfig = {
      driver: asyncDriver(driver),
      dialect: "sqlite",
      migrations: [migration()],
      models: [User],
    };

    expect((await runMigrationCli(["current"], cfg)).lines).toEqual([
      "(no migrations applied)",
    ]);
    expect((await runMigrationCli(["upgrade"], cfg)).lines).toEqual(["applied 001"]);
    expect((await runMigrationCli(["current"], cfg)).lines).toEqual(["001"]);
    expect((await runMigrationCli(["downgrade"], cfg)).lines).toEqual(["reverted 001"]);
    driver.close();
  });

  it("checks drift through the async introspection", async () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const cfg: CliConfig = {
      driver: asyncDriver(driver),
      dialect: "sqlite",
      migrations: [migration()],
      models: [User],
    };
    await runMigrationCli(["upgrade"], cfg);
    const clean = await runMigrationCli(["check"], cfg);
    expect(clean.code).toBe(0);
    expect(clean.lines).toEqual(["no drift; models match migrations"]);

    driver.execute("ALTER TABLE users ADD COLUMN stray TEXT", []);
    const dirty = await runMigrationCli(["check"], cfg);
    expect(dirty.code).toBe(1);
    expect(dirty.lines.join("\n")).toContain("stray");
    driver.close();
  });

  it("reports that MySQL drift checking is not implemented", async () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const cfg: CliConfig = {
      driver: asyncDriver(driver),
      dialect: "mysql",
      migrations: [migration()],
      models: [User],
    };
    const result = await runMigrationCli(["check"], cfg);
    expect(result.lines.join("\n")).toContain("not implemented for MySQL");
    driver.close();
  });
});
