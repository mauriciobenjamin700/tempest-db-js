import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  BaseRepository,
  Model,
  column,
  createEngine,
  insert,
  isReadOnlyStatement,
  select,
} from "../src/index.js";

class Note extends Model {
  static override tablename = "notes";
  id = column.integer().primaryKey();
  authorId = column.integer().notNull();
  title = column.varchar(80).notNull();
}

const DDL =
  "CREATE TABLE notes (id INTEGER PRIMARY KEY, authorId INTEGER NOT NULL, title TEXT NOT NULL)";

describe("engine.explain", () => {
  let engine: AsyncEngine;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL, []);
    await engine.session().execute(
      insert(Note).values([
        { id: 1, authorId: 1, title: "a" },
        { id: 2, authorId: 2, title: "b" },
      ]),
    );
  });

  it("returns one plan per statement, in order", async () => {
    const report = await engine.explain(async (session) => {
      await session.execute(select(Note).where({ id: 1 })).all();
      await session.execute(select(Note).where({ authorId: 2 })).all();
    });

    expect(report.plans).toHaveLength(2);
    expect(report.plans[0]?.sql).toContain('WHERE "id" = ?');
    expect(report.plans[0]?.params).toEqual([1]);
    expect(report.plans[1]?.params).toEqual([2]);
  });

  it("identifies an index scan and a table scan", async () => {
    const report = await engine.explain(async (session) => {
      await session.execute(select(Note).where({ id: 1 })).all();
      await session.execute(select(Note).where({ title: "a" })).all();
    });

    expect(report.plans[0]?.summary()).toMatch(/SEARCH .*PRIMARY KEY/i);
    expect(report.plans[1]?.summary()).toMatch(/SCAN/i);
  });

  it("still runs the block, so its effects happen once", async () => {
    const repo = new BaseRepository(Note, engine.session());
    await engine.explain(async (session) => {
      await new BaseRepository(Note, session).create({ id: 3, authorId: 1, title: "c" });
    });
    expect(await repo.count()).toBe(3);
  });

  it("filters which statements are explained", async () => {
    const report = await engine.explain(
      async (session) => {
        await session.execute(select(Note)).all();
        await new BaseRepository(Note, session).create({
          id: 4,
          authorId: 1,
          title: "d",
        });
      },
      { filter: isReadOnlyStatement },
    );
    expect(report.plans).toHaveLength(1);
    expect(report.plans[0]?.sql.startsWith("SELECT")).toBe(true);
  });

  it("refuses ANALYZE on SQLite, which does not have it", async () => {
    await expect(
      engine.explain(
        async (session) => {
          await session.execute(select(Note)).all();
        },
        { analyze: true },
      ),
    ).rejects.toThrow(/no EXPLAIN ANALYZE/);
  });

  it("summary() digests every plan", async () => {
    const report = await engine.explain(async (session) => {
      await session.execute(select(Note)).all();
    });
    expect(report.summary()).toContain("notes");
  });
});

describe("isReadOnlyStatement", () => {
  it("recognizes the statements ANALYZE may safely execute", () => {
    expect(isReadOnlyStatement("SELECT 1")).toBe(true);
    expect(isReadOnlyStatement("  with x as (select 1) select * from x")).toBe(true);
    expect(isReadOnlyStatement("UPDATE t SET a = 1")).toBe(false);
    expect(isReadOnlyStatement("INSERT INTO t VALUES (1)")).toBe(false);
  });
});
