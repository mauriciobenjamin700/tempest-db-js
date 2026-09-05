import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  Model,
  type QueryEndEvent,
  column,
  createEngine,
  insert,
  select,
} from "../src/index.js";

class Row extends Model {
  static override tablename = "rows";
  id = column.integer().primaryKey();
  label = column.varchar(40).notNull();
}

const DDL = "CREATE TABLE rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL)";

/** Build an engine capturing both hooks. */
function engineWith(options: {
  slowQueryMs?: number;
}): { engine: AsyncEngine; started: string[]; ended: QueryEndEvent[] } {
  const started: string[] = [];
  const ended: QueryEndEvent[] = [];
  const engine = createEngine("sqlite://:memory:", {
    onQuery: ({ sql }) => started.push(sql),
    onQueryEnd: (event) => ended.push(event),
    ...(options.slowQueryMs === undefined ? {} : { slowQueryMs: options.slowQueryMs }),
  });
  return { engine, started, ended };
}

describe("onQueryEnd", () => {
  let engine: AsyncEngine;
  let started: string[];
  let ended: QueryEndEvent[];

  beforeEach(async () => {
    ({ engine, started, ended } = engineWith({}));
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL, []);
    started.length = 0;
    ended.length = 0;
  });

  it("reports the same statement onQuery announced, with a duration", async () => {
    await engine.session().execute(insert(Row).values({ id: 1, label: "a" }));
    expect(started).toHaveLength(1);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.sql).toBe(started[0]);
    expect(ended[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(ended[0]?.error).toBeUndefined();
  });

  it("reports rows returned for a read and rows affected for a write", async () => {
    await engine.session().execute(
      insert(Row).values([
        { id: 1, label: "a" },
        { id: 2, label: "b" },
      ]),
    );
    expect(ended.at(-1)?.rowCount).toBe(2);

    await engine.session().execute(select(Row)).all();
    expect(ended.at(-1)?.rowCount).toBe(2);
  });

  it("fires on the failure path, carrying the driver error", async () => {
    await engine.session().execute(insert(Row).values({ id: 1, label: "a" }));
    await expect(
      engine
        .session()
        .execute(insert(Row).values({ id: 1, label: "dup" }))
        .rowsAffected(),
    ).rejects.toThrow();
    const last = ended.at(-1);
    expect(last?.error).toBeDefined();
    expect(last?.rowCount).toBe(0);
    expect(last?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("measures a stream until the iteration ends", async () => {
    await engine.session().execute(
      insert(Row).values([
        { id: 1, label: "a" },
        { id: 2, label: "b" },
        { id: 3, label: "c" },
      ]),
    );
    ended.length = 0;
    const seen: string[] = [];
    for await (const row of engine.session().stream(select(Row))) {
      seen.push(row.label);
    }
    expect(seen).toEqual(["a", "b", "c"]);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.rowCount).toBe(3);
  });

  it("slowQueryMs filters out the fast statements", async () => {
    const slow = engineWith({ slowQueryMs: 60_000 });
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (slow.engine as any).driver.execute(DDL, []);
    await slow.engine.session().execute(insert(Row).values({ id: 1, label: "a" }));
    expect(slow.started.length).toBeGreaterThan(0);
    expect(slow.ended).toEqual([]);
    await slow.engine.close();
  });

  it("never lets a throwing hook break the query", async () => {
    const engineB = createEngine("sqlite://:memory:", {
      onQueryEnd: () => {
        throw new Error("hook exploded");
      },
    });
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engineB as any).driver.execute(DDL, []);
    const row = await engineB
      .session()
      .execute(insert(Row).values({ id: 1, label: "a" }).returning())
      .one();
    expect(row.label).toBe("a");
    await engineB.close();
  });
});
