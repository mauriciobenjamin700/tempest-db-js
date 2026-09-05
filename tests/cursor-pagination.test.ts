import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  BaseRepository,
  InvalidCursor,
  Model,
  column,
  createEngine,
} from "../src/index.js";

class Event extends Model {
  static override tablename = "events";
  id = column.integer().primaryKey();
  bucket = column.integer().notNull();
  label = column.varchar(40).notNull();
}

const DDL =
  "CREATE TABLE events (id INTEGER PRIMARY KEY, bucket INTEGER NOT NULL, label TEXT NOT NULL)";

/** Walk every page, collecting the ids in order. */
async function drain(
  repo: BaseRepository<typeof Event>,
  pageSize: number,
  ascending: boolean,
): Promise<number[]> {
  const seen: number[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const page: { items: { id: number }[]; nextCursor: string | null } =
      await repo.cursorPaginate({ cursor, limit: pageSize, ascending });
    seen.push(...page.items.map((r) => r.id));
    if (page.nextCursor === null) return seen;
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

describe("cursorPaginate", () => {
  let engine: AsyncEngine;
  let repo: BaseRepository<typeof Event>;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL, []);
    repo = new BaseRepository(Event, engine.session());
    await repo.createMany(
      Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        bucket: Math.floor(i / 3),
        label: `e${i + 1}`,
      })),
    );
  });

  it("walks the whole table without repeating or skipping a row", async () => {
    expect(await drain(repo, 3, true)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await drain(repo, 4, false)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("returns null as the next cursor on the last page", async () => {
    const page = await repo.cursorPaginate({ limit: 20 });
    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).toBeNull();
  });

  it("breaks ties on the primary key so a shared orderBy value is not skipped", async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page: { items: { id: number }[]; nextCursor: string | null } =
        await repo.cursorPaginate({
          cursor,
          limit: 2,
          orderBy: "bucket",
          ascending: true,
        });
      seen.push(...page.items.map((r) => r.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(seen).size).toBe(10);
  });

  it("is stable when rows are inserted between pages", async () => {
    const first = await repo.cursorPaginate({ limit: 3, ascending: true });
    expect(first.items.map((r) => r.id)).toEqual([1, 2, 3]);

    await repo.create({ id: 100, bucket: 0, label: "inserted" });

    const second = await repo.cursorPaginate({
      cursor: first.nextCursor,
      limit: 3,
      ascending: true,
    });
    expect(second.items.map((r) => r.id)).toEqual([4, 5, 6]);
  });

  it("applies the domain filters to every page", async () => {
    const page = await repo.cursorPaginate({
      filters: { bucket: 1 },
      limit: 10,
      ascending: true,
    });
    expect(page.items.map((r) => r.id)).toEqual([4, 5, 6]);
  });

  it("rejects a cursor it did not produce", async () => {
    await expect(repo.cursorPaginate({ cursor: "not-a-cursor" })).rejects.toThrow(
      InvalidCursor,
    );
    await expect(
      repo.cursorPaginate({ cursor: Buffer.from('{"v":2}').toString("base64url") }),
    ).rejects.toThrow(/unknown cursor version/);
  });

  it("rejects a cursor built for another ordering", async () => {
    const byId = await repo.cursorPaginate({ limit: 2 });
    await expect(
      repo.cursorPaginate({ cursor: byId.nextCursor, orderBy: "bucket" }),
    ).rejects.toThrow(/ordering changed between pages/);
  });
});
