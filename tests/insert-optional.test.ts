import { describe, expect, it } from "vitest";
import {
  Model,
  type SyncSession,
  ValidationError,
  column,
  createSyncEngine,
  getDialect,
  insert,
  select,
  sql,
} from "../src/index.js";

class Outbound extends Model {
  static override tablename = "outbound_messages";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  consumer = column.text().notNull();
  lastError = column.text();
  waMessageId = column.text();
  sentAt = column.datetime();
}

class Defaulted extends Model {
  static override tablename = "defaulted";
  id = column.integer().primaryKey();
  label = column.text().notNull();
  tier = column.text().default("free");
}

const pg = getDialect("postgresql");

function session(): SyncSession {
  const s = createSyncEngine("sqlite://:memory:").session();
  s.raw(
    `CREATE TABLE outbound_messages (
       id INTEGER PRIMARY KEY,
       consumer TEXT NOT NULL,
       last_error TEXT,
       wa_message_id TEXT,
       sent_at TEXT
     )`,
  );
  return s;
}

describe("nullable columns are optional on insert", () => {
  it("omits the column entirely, letting SQL apply NULL", () => {
    const q = insert(Outbound).values({ consumer: "acme" });
    expect(pg.compile(q.node)).toEqual({
      sql: 'INSERT INTO "outbound_messages" ("consumer") VALUES ($1)',
      params: ["acme"],
    });
  });

  it("still accepts an explicit null for the caller who wants to be explicit", () => {
    const q = insert(Outbound).values({ consumer: "acme", lastError: null });
    expect(pg.compile(q.node)).toEqual({
      sql: 'INSERT INTO "outbound_messages" ("consumer", "last_error") VALUES ($1, $2)',
      params: ["acme", null],
    });
  });

  it("reads back as null against a real database", () => {
    const s = session();
    s.execute(insert(Outbound).values({ id: 1, consumer: "acme" }));
    expect(s.execute(select(Outbound).where({ id: 1 })).one()).toEqual({
      id: 1,
      consumer: "acme",
      lastError: null,
      waMessageId: null,
      sentAt: null,
    });
  });

  it("keeps notNull columns without a default required", () => {
    // @ts-expect-error - `consumer` is notNull with no default
    insert(Outbound).values({ lastError: "x" });
  });
});

describe("multi-row inserts share one column list", () => {
  it("names every column any row supplies, instead of dropping later keys", () => {
    const q = insert(Outbound).values([
      { id: 1, consumer: "a" },
      { id: 2, consumer: "b", lastError: "kept" },
    ]);
    expect(pg.compile(q.node)).toEqual({
      sql:
        'INSERT INTO "outbound_messages" ("id", "consumer", "last_error") ' +
        "VALUES ($1, $2, $3), ($4, $5, $6)",
      params: [1, "a", null, 2, "b", "kept"],
    });
  });

  it("round-trips the value the later row supplied", () => {
    const s = session();
    s.execute(
      insert(Outbound).values([
        { id: 1, consumer: "a" },
        { id: 2, consumer: "b", lastError: "boom" },
      ]),
    );
    const rows = s.execute(select(Outbound).orderBy("id")).all();
    expect(rows.map((r) => r.lastError)).toEqual([null, "boom"]);
  });

  it("refuses rows that disagree about a defaulted column", () => {
    expect(() =>
      insert(Defaulted).values([{ label: "a" }, { label: "b", tier: "pro" }]),
    ).toThrow(ValidationError);
  });

  it("names the offending column and why it cannot be resolved", () => {
    try {
      insert(Defaulted).values([{ label: "a" }, { label: "b", tier: "pro" }]);
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as ValidationError).message;
      expect(message).toContain('"tier"');
      expect(message).toContain("would be written as NULL instead of taking");
    }
  });

  it("allows rows that disagree only about plain nullable columns", () => {
    expect(() =>
      insert(Outbound).values([
        { consumer: "a" },
        { consumer: "b", sentAt: new Date(0) },
      ]),
    ).not.toThrow();
  });

  it("leaves a single-row insert alone", () => {
    expect(() => insert(Defaulted).values({ label: "a" })).not.toThrow();
  });
});

describe("expressions still work on optional columns", () => {
  it("renders an expression for a nullable column", () => {
    const q = insert(Outbound).values({ consumer: "a", sentAt: sql.now() });
    expect(pg.compile(q.node).sql).toContain("VALUES ($1, now())");
  });
});
