import { describe, expect, it } from "vitest";
import {
  type InferModel,
  Model,
  QueryExecutionError,
  type SyncSession,
  column,
  createEngine,
  createSyncEngine,
  insert,
} from "../src/index.js";

class Event extends Model {
  static override tablename = "events";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  count = column.integer().notNull();
  createdAt = column.datetime().notNull();
}

type EventRow = InferModel<typeof Event>;

function session(): SyncSession {
  const s = createSyncEngine("sqlite://:memory:").session();
  s.raw(
    `CREATE TABLE events (
       id INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       count INTEGER NOT NULL,
       createdAt TEXT NOT NULL
     )`,
  );
  return s;
}

describe("session.raw — the runtime escape hatch", () => {
  it("runs a parameterized statement and returns rows", () => {
    const s = session();
    s.execute(
      insert(Event).values({ id: 1, name: "sent", count: 3, createdAt: new Date(0) }),
    );
    const rows = s.raw("SELECT name, count FROM events WHERE count >= ?", [2]).all();
    expect(rows).toEqual([{ name: "sent", count: 3 }]);
  });

  it("coerces rows through a model when given `as`", () => {
    const s = session();
    const when = new Date("2026-01-02T03:04:05.000Z");
    s.execute(insert(Event).values({ id: 1, name: "sent", count: 1, createdAt: when }));
    const row = s.raw<EventRow>("SELECT * FROM events", [], { as: Event }).one();
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.createdAt.toISOString()).toBe(when.toISOString());
  });

  it("reports rows affected for a write", () => {
    const s = session();
    s.execute(
      insert(Event).values({ id: 1, name: "sent", count: 1, createdAt: new Date(0) }),
    );
    const affected = s
      .raw("UPDATE events SET count = count + 1 WHERE id = ?", [1])
      .rowsAffected();
    expect(affected).toBe(1);
  });

  it("wraps a driver failure in QueryExecutionError with the SQL", () => {
    const s = session();
    expect(() => s.raw("SELECT * FROM nope", [])).toThrow(QueryExecutionError);
    try {
      s.raw("SELECT * FROM nope", []);
    } catch (error) {
      expect((error as QueryExecutionError).sql).toBe("SELECT * FROM nope");
    }
  });

  it("reports the statement through onQuery like any other", () => {
    const seen: string[] = [];
    const engine = createSyncEngine("sqlite://:memory:", {
      onQuery: (event) => seen.push(event.sql),
    });
    const s = engine.session();
    s.raw("CREATE TABLE t (id INTEGER)");
    expect(seen).toContain("CREATE TABLE t (id INTEGER)");
  });

  it("rejects a non-array params argument", () => {
    const s = session();
    expect(() => s.raw("SELECT 1", "1" as never)).toThrow(TypeError);
  });

  it("participates in a transaction and rolls back with it", () => {
    const s = session();
    expect(() =>
      s.transaction((tx) => {
        tx.raw("INSERT INTO events (id, name, count, createdAt) VALUES (?, ?, ?, ?)", [
          1,
          "sent",
          1,
          "2026-01-01",
        ]);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.raw("SELECT count(*) AS n FROM events").scalar()).toBe(0);
  });

  it("is available on the async session too", async () => {
    const engine = createEngine("sqlite://:memory:");
    const s = engine.session();
    await s.raw("CREATE TABLE t (id INTEGER)");
    await s.raw("INSERT INTO t (id) VALUES (?)", [7]);
    expect(await s.raw<{ id: number }>("SELECT id FROM t").scalar()).toBe(7);
    await engine.close();
  });
});
