import { describe, expect, it } from "vitest";
import { Model, column, getDialect, insert } from "../src/index.js";

class Outbound extends Model {
  static override tablename = "outbound_messages";
  id = column.text().primaryKey();
  consumer = column.text().notNull();
  idempotencyKey = column.text();
  status = column.text().notNull();
  attempts = column.integer().notNull();
}

const pg = getDialect("postgresql");
const sqlite = getDialect("sqlite");
const mysql = getDialect("mysql");

const row = {
  id: "a",
  consumer: "c",
  idempotencyKey: "k",
  status: "queued",
  attempts: 0,
};

describe("ON CONFLICT with a partial-index predicate", () => {
  it("repeats the index predicate on the conflict target", () => {
    const q = insert(Outbound)
      .values(row)
      .onConflictDoNothing(["consumer", "idempotencyKey"], {
        where: { idempotencyKey: { isNull: false } },
      })
      .returning();
    expect(pg.compile(q.node).sql).toContain(
      'ON CONFLICT ("consumer", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL DO NOTHING',
    );
  });

  it("binds values, then the index predicate, then the DO UPDATE set", () => {
    const q = insert(Outbound)
      .values(row)
      .onConflictDoUpdate(
        ["consumer", "idempotencyKey"],
        { status: "retry" },
        {
          indexWhere: { consumer: "c" },
          updateWhere: { attempts: { lt: 5 } },
        },
      );
    const compiled = pg.compile(q.node);
    expect(compiled.sql).toBe(
      'INSERT INTO "outbound_messages" ("id", "consumer", "idempotencyKey", "status", "attempts") ' +
        "VALUES ($1, $2, $3, $4, $5) " +
        'ON CONFLICT ("consumer", "idempotencyKey") WHERE "consumer" = $6 ' +
        'DO UPDATE SET "status" = $7 WHERE "attempts" < $8',
    );
    expect(compiled.params).toEqual(["a", "c", "k", "queued", 0, "c", "retry", 5]);
  });

  it("works on SQLite, which also supports the predicate", () => {
    const q = insert(Outbound)
      .values(row)
      .onConflictDoNothing(["consumer", "idempotencyKey"], {
        where: { idempotencyKey: { isNull: false } },
      });
    expect(sqlite.compile(q.node).sql).toContain(
      'WHERE "idempotencyKey" IS NOT NULL DO NOTHING',
    );
  });

  it("throws on MySQL, which has no conflict target", () => {
    const q = insert(Outbound)
      .values(row)
      .onConflictDoNothing(["consumer"], {
        where: { idempotencyKey: { isNull: false } },
      });
    expect(() => mysql.compile(q.node)).toThrow(/no conflict-target predicate/);
  });

  it("does not serve a predicate-bearing insert from the template cache", () => {
    const base = insert(Outbound).values(row);
    const withKey = base.onConflictDoNothing(["consumer", "idempotencyKey"], {
      where: { idempotencyKey: { isNull: false } },
    });
    const withoutKey = base.onConflictDoNothing(["consumer", "idempotencyKey"], {
      where: { idempotencyKey: { isNull: true } },
    });
    expect(pg.compile(withKey.node).sql).toContain('"idempotencyKey" IS NOT NULL');
    expect(pg.compile(withoutKey.node).sql).toContain('"idempotencyKey" IS NULL');
  });

  it("leaves a plain upsert unchanged", () => {
    const q = insert(Outbound).values(row).onConflictDoUpdate(["id"], { status: "sent" });
    const compiled = pg.compile(q.node);
    expect(compiled.sql).toContain('ON CONFLICT ("id") DO UPDATE SET "status" = $6');
    expect(compiled.params).toEqual(["a", "c", "k", "queued", 0, "sent"]);
  });
});
