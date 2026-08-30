import { describe, expect, it } from "vitest";
import {
  Model,
  type SyncSession,
  column,
  createSyncEngine,
  del,
  getDialect,
  insert,
  select,
  sql,
  update,
} from "../src/index.js";

class Outbound extends Model {
  static override tablename = "outbound_messages";
  id = column.integer().primaryKey();
  status = column.text().notNull();
  attempts = column.integer().notNull();
  nextAttemptAt = column.integer().notNull();
}

class Archive extends Model {
  static override tablename = "archive";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  messageId = column.integer().notNull();
}

const pg = getDialect("postgresql");
const sqlite = getDialect("sqlite");

function session(): SyncSession {
  const s = createSyncEngine("sqlite://:memory:").session();
  s.raw(
    `CREATE TABLE outbound_messages (
       id INTEGER PRIMARY KEY,
       status TEXT NOT NULL,
       attempts INTEGER NOT NULL,
       nextAttemptAt INTEGER NOT NULL
     )`,
  );
  s.raw("CREATE TABLE archive (id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL)");
  for (let i = 1; i <= 5; i++) {
    s.execute(
      insert(Outbound).values({
        id: i,
        status: i <= 3 ? "queued" : "sent",
        attempts: 0,
        nextAttemptAt: i,
      }),
    );
  }
  return s;
}

describe("subquery as an IN operand", () => {
  it("embeds the SELECT, binding its params at the right position", () => {
    const q = update(Outbound)
      .set({ status: "sending", attempts: sql.raw("attempts + 1") })
      .where({
        id: {
          in: select(Outbound)
            .where({ status: "queued" })
            .orderBy("nextAttemptAt")
            .limit(10)
            .forUpdate({ skipLocked: true })
            .asSubquery("id"),
        },
      })
      .returning();
    expect(pg.compile(q.node)).toEqual({
      sql:
        'UPDATE "outbound_messages" SET "status" = $1, "attempts" = attempts + 1 ' +
        'WHERE "id" IN (SELECT "id" FROM "outbound_messages" WHERE "status" = $2 ' +
        'ORDER BY "nextAttemptAt" ASC LIMIT $3 FOR UPDATE SKIP LOCKED) RETURNING *',
      params: ["sending", "queued", 10],
    });
  });

  it("projects only the chosen column, whatever the outer select asked for", () => {
    const sub = select(Outbound, ["id", "status"]).asSubquery("id");
    expect(pg.compile(select(Outbound).where({ id: { in: sub } }).node).sql).toContain(
      'IN (SELECT "id" FROM "outbound_messages")',
    );
  });

  it("supports NOT IN", () => {
    const q = select(Outbound).where({
      id: { notIn: select(Outbound).where({ status: "sent" }).asSubquery("id") },
    });
    expect(pg.compile(q.node).sql).toContain('"id" NOT IN (SELECT "id"');
  });

  it("uses the inner model's own column-name map", () => {
    const q = select(Outbound).where({
      id: { in: select(Archive).asSubquery("messageId") },
    });
    expect(pg.compile(q.node).sql).toBe(
      'SELECT * FROM "outbound_messages" WHERE "id" IN (SELECT "message_id" FROM "archive")',
    );
  });

  it("works in a DELETE guard", () => {
    const q = del(Outbound).where({
      id: { in: select(Archive).asSubquery("messageId") },
    });
    expect(sqlite.compile(q.node).sql).toBe(
      'DELETE FROM "outbound_messages" WHERE "id" IN (SELECT "message_id" FROM "archive")',
    );
  });

  it("keeps ? placeholders coherent on SQLite", () => {
    const q = select(Outbound).where({
      status: "queued",
      id: {
        in: select(Outbound)
          .where({ attempts: { gt: 2 } })
          .limit(4)
          .asSubquery("id"),
      },
    });
    expect(sqlite.compile(q.node)).toEqual({
      sql:
        'SELECT * FROM "outbound_messages" WHERE "status" = ? AND "id" IN ' +
        '(SELECT "id" FROM "outbound_messages" WHERE "attempts" > ? LIMIT ?)',
      params: ["queued", 2, 4],
    });
  });

  it("runs against a real database", () => {
    const s = session();
    const claimed = s
      .execute(
        update(Outbound)
          .set({ status: "sending", attempts: sql.raw("attempts + 1") })
          .where({
            id: {
              in: select(Outbound)
                .where({ status: "queued" })
                .orderBy("nextAttemptAt")
                .limit(2)
                .asSubquery("id"),
            },
          })
          .returning(),
      )
      .all();
    expect(claimed.map((r) => r.id)).toEqual([1, 2]);
    expect(claimed.every((r) => r.attempts === 1)).toBe(true);
    expect(
      s
        .execute(select(Outbound).where({ status: "queued" }))
        .all()
        .map((r) => r.id),
    ).toEqual([3]);
  });

  it("still accepts a plain list", () => {
    const s = session();
    expect(s.execute(select(Outbound).where({ id: { in: [1, 2] } })).all()).toHaveLength(
      2,
    );
    expect(s.execute(select(Outbound).where({ id: { in: [] } })).all()).toEqual([]);
  });
});
