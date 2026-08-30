import { describe, expect, it } from "vitest";
import { Model, column, getDialect, select } from "../src/index.js";

class Outbound extends Model {
  static override tablename = "outbound_messages";
  id = column.text().primaryKey();
  status = column.text().notNull();
  attempts = column.integer().notNull();
  nextAttemptAt = column.datetime().notNull();
}

const pg = getDialect("postgresql");
const mysql = getDialect("mysql");
const sqlite = getDialect("sqlite");

describe("FOR UPDATE / FOR SHARE", () => {
  it("renders the queue-claim clause after LIMIT on PostgreSQL", () => {
    const q = select(Outbound)
      .where({ status: "queued" })
      .orderBy("nextAttemptAt")
      .limit(10)
      .forUpdate({ skipLocked: true });
    expect(pg.compile(q.node)).toEqual({
      sql:
        'SELECT * FROM "outbound_messages" WHERE "status" = $1 ' +
        'ORDER BY "nextAttemptAt" ASC LIMIT $2 FOR UPDATE SKIP LOCKED',
      params: ["queued", 10],
    });
  });

  it("renders NOWAIT and FOR SHARE", () => {
    expect(pg.compile(select(Outbound).forUpdate({ noWait: true }).node).sql).toContain(
      "FOR UPDATE NOWAIT",
    );
    expect(pg.compile(select(Outbound).forShare().node).sql).toContain("FOR SHARE");
  });

  it("restricts the lock to named tables with OF", () => {
    const q = select(Outbound).forUpdate({ of: ["outbound_messages"] });
    expect(pg.compile(q.node).sql).toContain('FOR UPDATE OF "outbound_messages"');
  });

  it("works on MySQL, which supports SKIP LOCKED since 8.0", () => {
    const q = select(Outbound).forUpdate({ skipLocked: true });
    expect(mysql.compile(q.node).sql).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("throws on SQLite rather than emitting an unlocked SELECT", () => {
    const q = select(Outbound).forUpdate({ skipLocked: true });
    expect(() => sqlite.compile(q.node)).toThrow(/no row-level locking/);
  });

  it("rejects skipLocked together with noWait", () => {
    expect(() => select(Outbound).forUpdate({ skipLocked: true, noWait: true })).toThrow(
      /not both/,
    );
  });

  it("rejects a lock on an aggregate or DISTINCT query", () => {
    const grouped = select(Outbound).aggregate(["status"], {}).forUpdate();
    expect(() => pg.compile(grouped.node)).toThrow(/cannot be combined/);
    const distinct = select(Outbound).distinct().forUpdate();
    expect(() => pg.compile(distinct.node)).toThrow(/cannot be combined/);
  });

  it("leaves an unlocked select untouched", () => {
    expect(pg.compile(select(Outbound).node).sql).not.toContain("FOR UPDATE");
  });
});
