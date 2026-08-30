/**
 * `tempest-db` CLI against a real PostgreSQL.
 *
 * The CLI was SQLite-only until it ran on the async runner, so this is the test
 * that would have caught the gap: migrate, inspect, and drift-check a live
 * Postgres through the same commands a user types.
 *
 * Gated on `TEST_DATABASE_URL`, like the other PostgreSQL suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AsyncDriver,
  type AsyncEngine,
  Model,
  column,
  createEngine,
} from "../src/index.js";
import {
  type CliConfig,
  type Migration,
  type Op,
  reflectTable,
  runMigrationCli,
} from "../src/migrations/index.js";

const url = process.env.TEST_DATABASE_URL;

/**
 * A database of this suite's own.
 *
 * `tempest-db check` compares the **whole** schema against the models, so it
 * cannot share a database with the other integration files: their tables would
 * read as drift, and the exit code — the thing this suite is asserting — would
 * depend on test scheduling.
 */
const CLI_DATABASE = "tempest_db_js_cli_test";

/** Point a connection URL at a different database on the same server. */
function withDatabase(base: string, database: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Run one statement on the server's default database, then disconnect. */
async function onAdminConnection(statement: string): Promise<void> {
  const admin = createEngine(url as string);
  try {
    await admin.session().raw(statement).rowsAffected();
  } finally {
    await admin.close();
  }
}

class Widget extends Model {
  static override tablename = "cli_widgets";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  displayName = column.varchar(80).notNull();
  active = column.boolean().notNull();
}

function migration(): Migration {
  const table = reflectTable(Widget);
  return {
    revision: "001",
    downRevision: [],
    label: "create cli_widgets",
    up: (op: Op) => op.createTable(table),
    down: (op: Op) => op.dropTable(table),
  };
}

describe.skipIf(!url)("tempest-db CLI — real PostgreSQL", () => {
  let engine: AsyncEngine;
  let driver: AsyncDriver;
  let config: CliConfig;

  beforeAll(async () => {
    await onAdminConnection(`DROP DATABASE IF EXISTS ${CLI_DATABASE} WITH (FORCE)`);
    await onAdminConnection(`CREATE DATABASE ${CLI_DATABASE}`);
    engine = createEngine(withDatabase(url as string, CLI_DATABASE));
    driver = (engine as unknown as { driver: AsyncDriver }).driver;
    config = {
      driver,
      dialect: "postgresql",
      migrations: [migration()],
      models: [Widget],
      appliedAt: "2026-08-30T00:00:00.000Z",
    };
  });

  afterAll(async () => {
    await engine.close();
    await onAdminConnection(`DROP DATABASE IF EXISTS ${CLI_DATABASE} WITH (FORCE)`);
  });

  it("reports nothing applied on a fresh database", async () => {
    const result = await runMigrationCli(["current"], config);
    expect(result.code).toBe(0);
    expect(result.lines).toEqual(["(no migrations applied)"]);
  });

  it("prints the SQL it would run, without touching the database", async () => {
    const result = await runMigrationCli(["upgrade", "--sql"], config);
    expect(result.lines.join("\n")).toContain('CREATE TABLE "cli_widgets"');
    expect(result.lines.join("\n")).toContain('"display_name" VARCHAR(80) NOT NULL');
    expect((await runMigrationCli(["current"], config)).lines).toEqual([
      "(no migrations applied)",
    ]);
  });

  it("applies the migration for real", async () => {
    expect((await runMigrationCli(["upgrade"], config)).lines).toEqual(["applied 001"]);
    expect((await runMigrationCli(["current"], config)).lines).toEqual(["001"]);
    expect((await runMigrationCli(["history"], config)).lines[0]).toContain("✓ 001");
    const rows = await driver.execute(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'cli_widgets' ORDER BY column_name",
      [],
    );
    expect(rows.rows.map((r) => r.column_name)).toEqual(["active", "display_name", "id"]);
  });

  it("checks drift against the live schema", async () => {
    const clean = await runMigrationCli(["check"], config);
    expect(clean.code).toBe(0);
    expect(clean.lines).toEqual(["no drift; models match migrations"]);
  });

  it("detects a column added behind the models' back", async () => {
    await driver.execute("ALTER TABLE cli_widgets ADD COLUMN stray TEXT", []);
    const dirty = await runMigrationCli(["check"], config);
    expect(dirty.code).toBe(1);
    expect(dirty.lines.join("\n")).toContain("stray");
    await driver.execute("ALTER TABLE cli_widgets DROP COLUMN stray", []);
  });

  it("downgrades back to an empty schema", async () => {
    expect((await runMigrationCli(["downgrade"], config)).lines).toEqual([
      "reverted 001",
    ]);
    expect((await runMigrationCli(["current"], config)).lines).toEqual([
      "(no migrations applied)",
    ]);
    const exists = await driver.execute(
      "SELECT to_regclass('public.cli_widgets') AS t",
      [],
    );
    expect(exists.rows[0]?.t).toBeNull();
  });
});
