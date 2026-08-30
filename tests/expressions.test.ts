import { describe, expect, it } from "vitest";
import {
  Model,
  type SyncSession,
  ValidationError,
  column,
  createSyncEngine,
  getDialect,
  insert,
  isSqlExpression,
  select,
  sql,
  update,
} from "../src/index.js";

class Outbound extends Model {
  static override tablename = "outbound_messages";
  id = column.text().primaryKey();
  status = column.text().notNull();
  attempts = column.integer().notNull();
  payload = column.json<Record<string, unknown>>();
  updatedAt = column.datetime();
}

const pg = getDialect("postgresql");
const sqlite = getDialect("sqlite");

function session(): SyncSession {
  const s = createSyncEngine("sqlite://:memory:").session();
  s.raw(
    `CREATE TABLE outbound_messages (
       id TEXT PRIMARY KEY,
       status TEXT NOT NULL,
       attempts INTEGER NOT NULL,
       payload TEXT,
       updatedAt TEXT
     )`,
  );
  return s;
}

describe("SQL expressions in a write", () => {
  it("renders sql.raw inline instead of binding it", () => {
    const q = update(Outbound)
      .set({ attempts: sql.raw("attempts + 1") })
      .where({ id: "a" });
    expect(pg.compile(q.node)).toEqual({
      sql: 'UPDATE "outbound_messages" SET "attempts" = attempts + 1 WHERE "id" = $1',
      params: ["a"],
    });
  });

  it("binds the interpolations of a sql.expr template, in order", () => {
    const q = update(Outbound)
      .set({ attempts: sql.expr`attempts + ${2}`, status: "sending" })
      .where({ id: "a" });
    expect(pg.compile(q.node)).toEqual({
      sql: 'UPDATE "outbound_messages" SET "attempts" = attempts + $1, "status" = $2 WHERE "id" = $3',
      params: [2, "sending", "a"],
    });
  });

  it("renders a portable expression per dialect", () => {
    const q = update(Outbound).set({ updatedAt: sql.now() }).where({ id: "a" });
    expect(pg.compile(q.node).sql).toContain('"updatedAt" = now()');
    expect(sqlite.compile(q.node).sql).toContain('"updatedAt" = CURRENT_TIMESTAMP');
  });

  it("renders an expression inside INSERT VALUES", () => {
    const q = insert(Outbound).values({
      id: "a",
      status: "queued",
      attempts: 0,
      payload: null,
      updatedAt: sql.now(),
    });
    const compiled = pg.compile(q.node);
    expect(compiled.sql).toContain("VALUES ($1, $2, $3, $4, now())");
    expect(compiled.params).toEqual(["a", "queued", 0, null]);
  });

  it("increments atomically against a real database", () => {
    const s = session();
    s.execute(
      insert(Outbound).values({
        id: "a",
        status: "queued",
        attempts: 0,
        payload: null,
        updatedAt: null,
      }),
    );
    s.execute(
      update(Outbound)
        .set({ attempts: sql.raw("attempts + 1") })
        .where({ id: "a" }),
    );
    s.execute(
      update(Outbound)
        .set({ attempts: sql.raw("attempts + 1") })
        .where({ id: "a" }),
    );
    expect(s.execute(select(Outbound).where({ id: "a" })).one().attempts).toBe(2);
  });

  it("brands expressions so they are distinguishable from plain objects", () => {
    expect(isSqlExpression(sql.raw("now()"))).toBe(true);
    expect(isSqlExpression({ raw: "now()" })).toBe(false);
  });
});

describe("write-value validation", () => {
  it("rejects a bare object on a scalar column instead of writing null", () => {
    expect(() =>
      update(Outbound).set({ attempts: { raw: "attempts + 1" } } as never),
    ).toThrow(ValidationError);
  });

  it("rejects an array on a scalar column", () => {
    expect(() => insert(Outbound).values({ id: ["a"] } as never)).toThrow(
      ValidationError,
    );
  });

  it("rejects a key that is not a column", () => {
    expect(() => update(Outbound).set({ bogus: 1 } as never)).toThrow(
      /is not a column of outbound_messages/,
    );
  });

  it("still accepts objects on json columns", () => {
    expect(() =>
      update(Outbound).set({ payload: { to: "+55", text: "hi" } }),
    ).not.toThrow();
  });

  it("names the offending column in the message", () => {
    try {
      update(Outbound).set({ attempts: {} as never });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ValidationError).message).toContain('"attempts"');
      expect((error as ValidationError).message).toContain("sql.raw()");
    }
  });
});

describe("expressions are rejected where they cannot bind", () => {
  it("refuses sql.expr as a column default", () => {
    expect(() => column.integer().default(sql.expr`1 + ${1}`)).toThrow(/sql.raw/);
  });

  it("allows sql.raw as a column default", () => {
    expect(column.integer().default(sql.raw("0")).defaultValue).toMatchObject({
      kind: "expression",
    });
  });
});
