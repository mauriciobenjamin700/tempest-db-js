import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type SyncDriver, createEngine, createSyncEngine } from "../src/index.js";

const DRIVERS = ["node:sqlite", "better-sqlite3"] as const;

/** Reach the engine's private driver — these tests assert on raw pragma state. */
function driverOf(engine: object): SyncDriver {
  // biome-ignore lint/suspicious/noExplicitAny: the driver is private by design.
  return (engine as any).driver as SyncDriver;
}

/** Create the parent/child pair used by the foreign-key tests. */
function seedGraph(driver: SyncDriver): void {
  driver.execute("CREATE TABLE users (id INTEGER PRIMARY KEY)", []);
  driver.execute(
    "CREATE TABLE posts (id INTEGER PRIMARY KEY, userId INTEGER REFERENCES users(id) ON DELETE CASCADE)",
    [],
  );
  driver.execute("INSERT INTO users (id) VALUES (1)", []);
}

describe.each(DRIVERS)("SQLite foreign keys — %s", (driver) => {
  it("are enforced by default", () => {
    using engine = createSyncEngine("sqlite://:memory:", { driver });
    const d = driverOf(engine);
    seedGraph(d);
    expect(() => d.execute("INSERT INTO posts (id, userId) VALUES (1, 999)", [])).toThrow(
      /FOREIGN KEY/i,
    );
  });

  it("cascade on delete", () => {
    using engine = createSyncEngine("sqlite://:memory:", { driver });
    const d = driverOf(engine);
    seedGraph(d);
    d.execute("INSERT INTO posts (id, userId) VALUES (1, 1)", []);
    d.execute("DELETE FROM users WHERE id = 1", []);
    expect(d.execute("SELECT * FROM posts", []).rows).toEqual([]);
  });

  it("can be turned off for the case that needs it", () => {
    using engine = createSyncEngine("sqlite://:memory:", {
      driver,
      sqlite: { foreignKeys: false },
    });
    const d = driverOf(engine);
    seedGraph(d);
    d.execute("INSERT INTO posts (id, userId) VALUES (1, 999)", []);
    expect(d.execute("SELECT * FROM posts", []).rows).toHaveLength(1);
  });

  it("stay enforced on the async engine too", async () => {
    const engine = createEngine("sqlite://:memory:", { driver });
    const d = driverOf(engine);
    seedGraph(d);
    expect(() => d.execute("INSERT INTO posts (id, userId) VALUES (1, 999)", [])).toThrow(
      /FOREIGN KEY/i,
    );
    await engine.close();
  });
});

describe("SQLite pragmas", () => {
  const dir = mkdtempSync(join(tmpdir(), "tdbjs-pragma-"));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(DRIVERS)("sets journal_mode = WAL on a file database (%s)", (driver) => {
    const path = join(dir, `wal-${driver.replace(/\W/g, "")}.db`);
    using engine = createSyncEngine(`sqlite:///${path}`, {
      driver,
      sqlite: { journalMode: "wal" },
    });
    const [row] = driverOf(engine).execute("PRAGMA journal_mode", []).rows;
    expect(String(Object.values(row ?? {})[0]).toLowerCase()).toBe("wal");
  });

  it("refuses WAL on an in-memory database instead of silently keeping memory", () => {
    expect(() =>
      createSyncEngine("sqlite://:memory:", { sqlite: { journalMode: "wal" } }),
    ).toThrow(/an in-memory database cannot use WAL/);
  });

  it.each(DRIVERS)("sets busy_timeout (%s)", (driver) => {
    using engine = createSyncEngine("sqlite://:memory:", {
      driver,
      sqlite: { busyTimeoutMs: 4321 },
    });
    const [row] = driverOf(engine).execute("PRAGMA busy_timeout", []).rows;
    expect(Number(Object.values(row ?? {})[0])).toBe(4321);
  });

  it("rejects a busy timeout that is not a non-negative integer", () => {
    expect(() =>
      createSyncEngine("sqlite://:memory:", { sqlite: { busyTimeoutMs: -1 } }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      createSyncEngine("sqlite://:memory:", { sqlite: { busyTimeoutMs: 1.5 } }),
    ).toThrow(/non-negative integer/);
  });

  it.each(DRIVERS)("sets synchronous (%s)", (driver) => {
    using engine = createSyncEngine("sqlite://:memory:", {
      driver,
      sqlite: { synchronous: "off" },
    });
    const [row] = driverOf(engine).execute("PRAGMA synchronous", []).rows;
    expect(Number(Object.values(row ?? {})[0])).toBe(0);
  });

  it("rejects sqlite options on a server dialect", () => {
    expect(() =>
      createEngine("postgresql://app@localhost/app", { sqlite: { journalMode: "wal" } }),
    ).toThrow(/SQLite-only; postgresql/);
    expect(() =>
      createEngine("mysql://root@localhost/app", { sqlite: { foreignKeys: false } }),
    ).toThrow(/SQLite-only; mysql/);
  });
});
