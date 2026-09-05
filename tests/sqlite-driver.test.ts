import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  BetterSqliteDriver,
  type InferModel,
  Model,
  NodeSqliteDriver,
  type SyncDriver,
  type SyncEngine,
  column,
  createEngine,
  createSyncEngine,
  del,
  insert,
  select,
  update,
} from "../src/index.js";

class Note extends Model {
  static override tablename = "notes";
  id = column.integer().primaryKey();
  title = column.varchar(80).notNull();
  views = column.bigInteger().notNull();
  pinned = column.boolean().notNull();
  writtenAt = column.datetime().notNull();
  tags = column.json<string[]>();
}

type NoteRow = InferModel<typeof Note>;

const DDL = `
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  views INTEGER NOT NULL,
  pinned INTEGER NOT NULL,
  writtenAt TEXT NOT NULL,
  tags TEXT
)`;

/** Reach the engine's private driver — the point of these tests is which one it is. */
function driverOf(engine: { close(): void }): SyncDriver {
  // biome-ignore lint/suspicious/noExplicitAny: the driver is private by design.
  return (engine as any).driver as SyncDriver;
}

describe("SQLite driver selection", () => {
  it("defaults to the built-in node:sqlite", () => {
    using engine = createSyncEngine("sqlite://:memory:");
    expect(driverOf(engine)).toBeInstanceOf(NodeSqliteDriver);
  });

  it("honors the explicit driver option", () => {
    using engine = createSyncEngine("sqlite://:memory:", {
      driver: "better-sqlite3",
    });
    expect(driverOf(engine)).toBeInstanceOf(BetterSqliteDriver);
  });

  it("honors the URL suffix", () => {
    using engine = createSyncEngine("sqlite+better-sqlite3://:memory:");
    expect(driverOf(engine)).toBeInstanceOf(BetterSqliteDriver);
  });

  it("lets the explicit option win over the URL suffix", () => {
    using engine = createSyncEngine("sqlite+better-sqlite3://:memory:", {
      driver: "node:sqlite",
    });
    expect(driverOf(engine)).toBeInstanceOf(NodeSqliteDriver);
  });

  it("selects on the async engine too", async () => {
    const engine = createEngine("sqlite://:memory:", { driver: "better-sqlite3" });
    driverOf(engine as unknown as { close(): void }).execute(DDL, []);
    const rows = await engine.session().execute(select(Note)).all();
    expect(rows).toEqual([]);
    await engine.close();
  });

  it("rejects a driver it does not ship", () => {
    expect(() => createSyncEngine("sqlite://:memory:", { driver: "sqlite3" })).toThrow(
      /Unknown SQLite driver "sqlite3"/,
    );
  });

  it("ignores a suffix from another ecosystem, so Python URLs still connect", () => {
    using engine = createSyncEngine("sqlite+aiosqlite:///:memory:");
    expect(driverOf(engine)).toBeInstanceOf(NodeSqliteDriver);
  });

  it("rejects an unknown driver on a server dialect", () => {
    expect(() =>
      createEngine("postgresql://app@localhost/app", { driver: "asyncpg" }),
    ).toThrow(/Unknown postgresql driver "asyncpg"/);
    expect(() =>
      createEngine("mysql://root@localhost/app", { driver: "mysql3" }),
    ).toThrow(/Unknown mysql driver "mysql3"/);
  });

  it("accepts the driver each server dialect actually runs on", () => {
    expect(() =>
      createEngine("postgresql://app@localhost/app", { driver: "postgres" }),
    ).not.toThrow();
    expect(() =>
      createEngine("mysql://root@localhost/app", { driver: "mysql2" }),
    ).not.toThrow();
  });
});

describe("BetterSqliteDriver — real execution", () => {
  let engine: SyncEngine;

  beforeEach(() => {
    engine = createSyncEngine("sqlite+better-sqlite3://:memory:");
    driverOf(engine).execute(DDL, []);
    engine.session().execute(
      insert(Note).values([
        {
          id: 1,
          title: "first",
          views: 10n,
          pinned: true,
          writtenAt: new Date("2026-01-01T00:00:00.000Z"),
          tags: ["a"],
        },
        {
          id: 2,
          title: "second",
          views: 99999999999n,
          pinned: false,
          writtenAt: new Date("2026-02-01T00:00:00.000Z"),
          tags: null,
        },
      ]),
    );
  });

  it("round-trips bigint, Date, boolean and json", () => {
    const rows = engine.session().execute(select(Note).orderBy("id")).all();
    expect(rows).toHaveLength(2);
    const first = rows[0] as NoteRow;
    expect(first.views).toBe(10n);
    expect(first.pinned).toBe(true);
    expect(first.writtenAt).toBeInstanceOf(Date);
    expect(first.writtenAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(first.tags).toEqual(["a"]);
    expect((rows[1] as NoteRow).pinned).toBe(false);
    expect((rows[1] as NoteRow).tags).toBeNull();
    expect((rows[1] as NoteRow).views).toBe(99999999999n);
  });

  it("reports rows affected for update and delete", () => {
    const s = engine.session();
    expect(
      s.execute(update(Note).set({ pinned: true }).where({ id: 2 })).rowsAffected(),
    ).toBe(1);
    expect(s.execute(del(Note).where({ id: 1 })).rowsAffected()).toBe(1);
    expect(s.execute(select(Note)).all()).toHaveLength(1);
  });

  it("returns the row for RETURNING", () => {
    const row = engine
      .session()
      .execute(
        insert(Note)
          .values({
            id: 3,
            title: "third",
            views: 1n,
            pinned: false,
            writtenAt: new Date("2026-03-01T00:00:00.000Z"),
            tags: null,
          })
          .returning(),
      )
      .one() as NoteRow;
    expect(row.title).toBe("third");
    expect(row.views).toBe(1n);
  });

  it("streams rows lazily", () => {
    const titles: string[] = [];
    for (const row of engine.session().stream(select(Note).orderBy("id"))) {
      titles.push((row as NoteRow).title);
    }
    expect(titles).toEqual(["first", "second"]);
  });

  it("rolls a transaction back on error", () => {
    expect(() =>
      engine.transaction((tx) => {
        tx.execute(del(Note).where({ id: 1 }));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(engine.session().execute(select(Note)).all()).toHaveLength(2);
  });
});

describe("BetterSqliteDriver — driverOptions", () => {
  const dir = mkdtempSync(join(tmpdir(), "tdbjs-bsq-"));
  const path = join(dir, "notes.db");

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes driverOptions through to better-sqlite3", () => {
    {
      using writer = createSyncEngine(`sqlite:///${path}`, { driver: "better-sqlite3" });
      driverOf(writer).execute(DDL, []);
    }
    using reader = createSyncEngine(`sqlite:///${path}`, {
      driver: "better-sqlite3",
      driverOptions: { readonly: true },
    });
    expect(reader.session().execute(select(Note)).all()).toEqual([]);
    expect(() =>
      reader.session().execute(
        insert(Note).values({
          id: 1,
          title: "nope",
          views: 0n,
          pinned: false,
          writtenAt: new Date("2026-01-01T00:00:00.000Z"),
          tags: null,
        }),
      ),
    ).toThrow(/readonly/i);
  });
});
