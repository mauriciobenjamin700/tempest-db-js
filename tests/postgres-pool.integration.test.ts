/**
 * PostgreSQL integration for the pool's connection-health options — the part only
 * a real server can show: a connection killed server-side, and what the next
 * transaction does about it.
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
} from "../src/index.js";
import { reflectTable, renderOperation } from "../src/migrations/index.js";

const url = process.env.TEST_DATABASE_URL;

class PoolRow extends Model {
  static override tablename = "pool_rows";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  label = column.text().notNull();
}

/** Kill every backend of this database except the one asking. */
async function killOtherBackends(driver: AsyncDriver): Promise<void> {
  await driver.execute(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    [],
  );
}

describe.skipIf(!url)("PostgreSQL — pool health options", () => {
  let admin: AsyncEngine;
  let adminDriver: AsyncDriver;

  beforeAll(async () => {
    admin = createEngine(url as string);
    adminDriver = (admin as unknown as { driver: AsyncDriver }).driver;
    await adminDriver.execute("DROP TABLE IF EXISTS pool_rows CASCADE", []);
    for (const stmt of renderOperation(
      { kind: "create_table", table: reflectTable(PoolRow) },
      "postgresql",
    )) {
      await adminDriver.execute(stmt, []);
    }
  });

  afterAll(async () => {
    await adminDriver.execute("DROP TABLE IF EXISTS pool_rows CASCADE", []);
    await admin.close();
  });

  it("runs a transaction on a fresh connection after the old one was killed", async () => {
    const engine = createEngine(url as string, { pool: { size: 1, prePing: true } });
    try {
      const repo = new BaseRepository(PoolRow, engine.session());
      await repo.delete({ id: 1 });
      await engine.session().transaction(async (tx) => {
        await new BaseRepository(PoolRow, tx).create({ id: 1, label: "before" });
      });

      await killOtherBackends(adminDriver);

      await engine.session().transaction(async (tx) => {
        await new BaseRepository(PoolRow, tx).update({ id: 1 }, { label: "after" });
      });
      expect((await repo.getById(1)).label).toBe("after");
      await repo.delete({ id: 1 });
    } finally {
      await engine.close();
    }
  });

  it("accepts recycleMs as a connection max lifetime", async () => {
    const engine = createEngine(url as string, {
      pool: { size: 1, recycleMs: 60_000, prePing: true },
    });
    try {
      const repo = new BaseRepository(PoolRow, engine.session());
      await repo.create({ id: 2, label: "recycled" });
      expect((await repo.getById(2)).label).toBe("recycled");
      await repo.delete({ id: 2 });
    } finally {
      await engine.close();
    }
  });
});
