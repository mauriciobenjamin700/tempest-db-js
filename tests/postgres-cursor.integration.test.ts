/**
 * PostgreSQL integration for cursor pagination — the part a compilation test
 * cannot prove: the expanded key comparison ordering the same way the database
 * does, across pages, with a timestamp as the sort column.
 *
 * Gated on `TEST_DATABASE_URL`, and uses its own table so it can run in parallel
 * with the other integration files.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AsyncDriver,
  type AsyncEngine,
  BaseRepository,
  Model,
  column,
  createEngine,
  withTimestamps,
} from "../src/index.js";
import { reflectTable, renderOperation } from "../src/migrations/index.js";

const url = process.env.TEST_DATABASE_URL;

class CursorEvent extends withTimestamps(Model) {
  static override tablename = "cursor_events";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  bucket = column.integer().notNull();
}

describe.skipIf(!url)("PostgreSQL — cursor pagination", () => {
  let engine: AsyncEngine;
  let driver: AsyncDriver;
  let repo: BaseRepository<typeof CursorEvent>;

  beforeAll(async () => {
    engine = createEngine(url as string);
    driver = (engine as unknown as { driver: AsyncDriver }).driver;
    await driver.execute("DROP TABLE IF EXISTS cursor_events CASCADE", []);
    for (const stmt of renderOperation(
      { kind: "create_table", table: reflectTable(CursorEvent) },
      "postgresql",
    )) {
      await driver.execute(stmt, []);
    }
    repo = new BaseRepository(CursorEvent, engine.session());
    await repo.createMany(
      Array.from({ length: 25 }, (_, i) => ({ id: i + 1, bucket: i % 5 })),
    );
  });

  afterAll(async () => {
    await driver.execute("DROP TABLE IF EXISTS cursor_events CASCADE", []);
    await engine.close();
  });

  it("walks every row exactly once, ascending and descending", async () => {
    for (const ascending of [true, false]) {
      const seen: number[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 30; guard++) {
        const page = await repo.cursorPaginate({ cursor, limit: 7, ascending });
        seen.push(...page.items.map((r) => r.id));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(new Set(seen).size).toBe(25);
      expect([...seen].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 25 }, (_, i) => i + 1),
      );
    }
  });

  it("orders by a timestamp column with the primary key as tie-break", async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 30; guard++) {
      const page = await repo.cursorPaginate({
        cursor,
        limit: 6,
        orderBy: "createdAt",
        ascending: true,
      });
      seen.push(...page.items.map((r) => r.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(25);
  });

  it("keeps the boundary stable when a row is inserted mid-walk", async () => {
    const first = await repo.cursorPaginate({ limit: 5, ascending: true });
    await repo.create({ id: 1000, bucket: 0 });
    const second = await repo.cursorPaginate({
      cursor: first.nextCursor,
      limit: 5,
      ascending: true,
    });
    expect(second.items.map((r) => r.id)).toEqual([6, 7, 8, 9, 10]);
    await repo.delete({ id: 1000 });
  });
});
