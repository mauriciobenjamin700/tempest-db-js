import { describe, expect, it } from "vitest";
import {
  Model,
  type SyncSession,
  column,
  count,
  createSyncEngine,
  getDialect,
  insert,
  or,
  select,
  sum,
} from "../src/index.js";

class Outbound extends Model {
  static override tablename = "outbound_messages";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  consumerName = column.text().notNull();
  status = column.text().notNull();
  amount = column.integer().notNull();
}

const pg = getDialect("postgresql");
const mysql = getDialect("mysql");

function session(): SyncSession {
  const s = createSyncEngine("sqlite://:memory:").session();
  s.raw(
    `CREATE TABLE outbound_messages (
       id INTEGER PRIMARY KEY,
       consumer_name TEXT NOT NULL,
       status TEXT NOT NULL,
       amount INTEGER NOT NULL
     )`,
  );
  const rows = [
    ["a", "queued", 10],
    ["a", "queued", 20],
    ["a", "queued", 30],
    ["b", "queued", 5],
    ["c", "sent", 99],
  ] as const;
  rows.forEach(([consumerName, status, amount], i) =>
    s.execute(insert(Outbound).values({ id: i + 1, consumerName, status, amount })),
  );
  return s;
}

describe("HAVING", () => {
  it("re-emits the aggregate expression, not the alias", () => {
    const q = select(Outbound)
      .where({ status: "queued" })
      .aggregate(["consumerName"], { n: count() })
      .having({ n: { gt: 2 } });
    expect(pg.compile(q.node)).toEqual({
      sql:
        'SELECT "consumer_name", COUNT(*) AS "n" FROM "outbound_messages" ' +
        'WHERE "status" = $1 GROUP BY "consumer_name" HAVING COUNT(*) > $2',
      params: ["queued", 2],
    });
  });

  it("maps a grouped column through the name map", () => {
    const q = select(Outbound)
      .aggregate(["consumerName"], { n: count() })
      .having({ consumerName: { ne: "b" } });
    expect(pg.compile(q.node).sql).toContain('HAVING "consumer_name" <> $1');
  });

  it("resolves the aggregate's own column through the name map", () => {
    const q = select(Outbound)
      .aggregate(["status"], { total: sum("amount") })
      .having({ total: { gte: 50 } });
    expect(pg.compile(q.node).sql).toContain('HAVING SUM("amount") >= $1');
  });

  it("composes with and/or/not", () => {
    const q = select(Outbound)
      .aggregate(["consumerName"], { n: count(), total: sum("amount") })
      .having(
        or<{ n: number; total: number | null }>({ n: { gt: 2 } }, { total: { gt: 90 } }),
      );
    expect(pg.compile(q.node).sql).toContain(
      'HAVING (COUNT(*) > $1) OR (SUM("amount") > $2)',
    );
  });

  it("binds params between WHERE and LIMIT", () => {
    const q = select(Outbound)
      .where({ status: "queued" })
      .aggregate(["consumerName"], { n: count() })
      .having({ n: { gt: 1 } })
      .limit(5);
    expect(pg.compile(q.node).params).toEqual(["queued", 1, 5]);
  });

  it("orders by an aggregate alias, which every dialect accepts", () => {
    const q = select(Outbound)
      .aggregate(["consumerName"], { n: count() })
      .orderBy("n", "desc");
    expect(pg.compile(q.node).sql).toContain('ORDER BY "n" DESC');
    expect(mysql.compile(q.node).sql).toContain("ORDER BY `n` DESC");
  });

  it("filters groups against a real database", () => {
    const s = session();
    const rows = s
      .execute(
        select(Outbound)
          .where({ status: "queued" })
          .aggregate(["consumerName"], { n: count(), total: sum("amount") })
          .having({ n: { gt: 2 } }),
      )
      .all();
    expect(rows).toEqual([{ consumerName: "a", n: 3, total: 60 }]);
  });

  it("returns every group without having", () => {
    const s = session();
    const rows = s
      .execute(
        select(Outbound)
          .where({ status: "queued" })
          .aggregate(["consumerName"], { n: count() })
          .orderBy("n", "desc"),
      )
      .all();
    expect(rows.map((r) => r.consumerName)).toEqual(["a", "b"]);
  });
});
