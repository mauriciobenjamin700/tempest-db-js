import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  BaseRepository,
  Model,
  RecordNotFound,
  column,
  createEngine,
  getDialect,
  insert,
  sql,
  withSoftDelete,
  withTimestamps,
} from "../src/index.js";

class Item extends withSoftDelete(withTimestamps(Model)) {
  static override tablename = "items";
  id = column.integer().primaryKey();
  sku = column.varchar(40).notNull();
  qty = column.integer().notNull();
}

class Plain extends Model {
  static override tablename = "plains";
  id = column.integer().primaryKey();
  label = column.varchar(20).notNull();
}

class Composite extends Model {
  static override tablename = "composites";
  orderId = column.integer().primaryKey();
  lineNumber = column.integer().primaryKey();
}

const DDL = [
  `CREATE TABLE items (
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deletedAt TEXT,
    id INTEGER PRIMARY KEY,
    sku TEXT NOT NULL UNIQUE,
    qty INTEGER NOT NULL)`,
  "CREATE TABLE plains (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
  "CREATE TABLE composites (orderId INTEGER NOT NULL, lineNumber INTEGER NOT NULL, PRIMARY KEY (orderId, lineNumber))",
];

describe("BaseRepository — the methods that were missing", () => {
  let engine: AsyncEngine;
  let items: BaseRepository<typeof Item>;
  let plains: BaseRepository<typeof Plain>;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    for (const stmt of DDL) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
    items = new BaseRepository(Item, engine.session());
    plains = new BaseRepository(Plain, engine.session());
    await items.createMany([
      { id: 1, sku: "a", qty: 1 },
      { id: 2, sku: "b", qty: 2 },
      { id: 3, sku: "c", qty: 3 },
    ]);
  });

  it("existsExcluding ignores the row being edited", async () => {
    expect(await items.exists({ sku: "a" })).toBe(true);
    expect(await items.existsExcluding({ sku: "a" }, 1)).toBe(false);
    expect(await items.existsExcluding({ sku: "a" }, 2)).toBe(true);
  });

  it("bulkUpsert inserts and overwrites in one statement", async () => {
    const written = await items.bulkUpsert(
      [
        { id: 1, sku: "a", qty: 100 },
        { id: 9, sku: "z", qty: 9 },
      ],
      { conflictColumns: ["id"] },
    );
    expect(written.map((r) => r.qty).sort((a, b) => a - b)).toEqual([9, 100]);
    expect((await items.getById(1)).qty).toBe(100);
    expect(await items.count()).toBe(4);
  });

  it("bulkUpsert can restrict which columns are overwritten", async () => {
    await items.bulkUpsert([{ id: 1, sku: "a", qty: 500 }], {
      conflictColumns: ["id"],
      update: ["qty"],
    });
    expect((await items.getById(1)).qty).toBe(500);
  });

  it("bulkUpsert is a no-op for an empty list and rejects a missing target", async () => {
    expect(await items.bulkUpsert([], { conflictColumns: ["id"] })).toEqual([]);
    await expect(
      items.bulkUpsert([{ id: 5, sku: "e", qty: 1 }], { conflictColumns: [] }),
    ).rejects.toThrow(/at least one conflict column/);
  });

  it("softDelete and restore flip deletedAt", async () => {
    const deleted = await items.softDelete(1);
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(await items.count()).toBe(3);

    const restored = await items.restore(1);
    expect(restored.deletedAt).toBeNull();
  });

  it("softDelete refuses a model without the column, and a missing row", async () => {
    await expect(plains.softDelete(1)).rejects.toThrow(/has no "deletedAt" column/);
    await expect(items.softDelete(999)).rejects.toThrow(RecordNotFound);
  });

  it("deleteBatch removes many keys and reports the count", async () => {
    expect(await items.deleteBatch([1, 2, 999])).toBe(2);
    expect(await items.count()).toBe(1);
    expect(await items.deleteBatch([])).toBe(0);
  });

  it("deleteBatch refuses a composite key instead of guessing", async () => {
    const composites = new BaseRepository(Composite, engine.session());
    await expect(composites.deleteBatch([1])).rejects.toThrow(
      /composite primary key.*single-column keys only/s,
    );
  });

  it("changesSince returns the delta, ordered oldest first, with a watermark", async () => {
    const first = await items.changesSince({});
    expect(first.items.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(first.serverTime).toBeInstanceOf(Date);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await items.update({ id: 2 }, { qty: 22 });

    const delta = await items.changesSince({ since: first.serverTime });
    expect(delta.items.map((r) => r.id)).toEqual([2]);
  });

  it("changesSince includes soft-deleted rows as tombstones", async () => {
    const start = new Date(Date.now() - 60_000);
    await items.softDelete(3);
    const delta = await items.changesSince({ since: start });
    const tombstone = delta.items.find((r) => r.id === 3);
    expect(tombstone?.deletedAt).toBeInstanceOf(Date);
  });

  it("changesSince refuses a model with no updatedAt", async () => {
    await expect(plains.changesSince({})).rejects.toThrow(/has no "updatedAt" column/);
  });
});

describe("sql.excluded", () => {
  it("names the incoming row per dialect", () => {
    const builder = insert(Plain)
      .values({ id: 1, label: "a" })
      .onConflictDoUpdate(["id"], { label: sql.excluded("label") });
    const node = (builder as unknown as { node: never }).node;
    expect(getDialect("postgresql").compile(node).sql).toContain(
      'DO UPDATE SET "label" = excluded."label"',
    );
    expect(getDialect("sqlite").compile(node).sql).toContain(
      'DO UPDATE SET "label" = excluded."label"',
    );
    expect(getDialect("mysql").compile(node).sql).toContain("VALUES(label)");
  });
});
