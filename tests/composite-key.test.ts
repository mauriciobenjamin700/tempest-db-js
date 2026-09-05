import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  BaseRepository,
  type InferModel,
  Model,
  RecordNotFound,
  activeRecord,
  column,
  createEngine,
  primaryKeyFilter,
  primaryKeysOf,
} from "../src/index.js";

class OrderLine extends Model {
  static override tablename = "order_lines";
  orderId = column.integer().primaryKey();
  lineNumber = column.integer().primaryKey();
  sku = column.varchar(40).notNull();
  qty = column.integer().notNull();
}

class Single extends Model {
  static override tablename = "singles";
  id = column.integer().primaryKey();
  label = column.varchar(40).notNull();
}

class Keyless extends Model {
  static override tablename = "keyless";
  label = column.varchar(40).notNull();
}

type LineRow = InferModel<typeof OrderLine>;

const DDL = [
  "CREATE TABLE order_lines (orderId INTEGER NOT NULL, lineNumber INTEGER NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL, PRIMARY KEY (orderId, lineNumber))",
  "CREATE TABLE singles (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
];

describe("primaryKeysOf / primaryKeyFilter", () => {
  it("lists every key column, in declaration order", () => {
    expect(primaryKeysOf(OrderLine)).toEqual(["orderId", "lineNumber"]);
    expect(primaryKeysOf(Single)).toEqual(["id"]);
  });

  it("throws when the model has no primary key", () => {
    expect(() => primaryKeysOf(Keyless)).toThrow(/has no primary key/);
  });

  it("takes a scalar or an object for a single-column key", () => {
    expect(primaryKeyFilter(Single, 7)).toEqual({ id: 7 });
    expect(primaryKeyFilter(Single, { id: 7 })).toEqual({ id: 7 });
  });

  it("requires the whole key for a composite one", () => {
    expect(primaryKeyFilter(OrderLine, { orderId: 1, lineNumber: 2 })).toEqual({
      orderId: 1,
      lineNumber: 2,
    });
    expect(() => primaryKeyFilter(OrderLine, 1)).toThrow(
      /composite primary key \(orderId, lineNumber\).*instead of a scalar/s,
    );
    expect(() => primaryKeyFilter(OrderLine, { orderId: 1 })).toThrow(
      /missing "lineNumber"/,
    );
  });
});

describe("BaseRepository with a composite primary key", () => {
  let engine: AsyncEngine;
  let repo: BaseRepository<typeof OrderLine>;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    for (const stmt of DDL) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
    repo = new BaseRepository(OrderLine, engine.session());
    await repo.createMany([
      { orderId: 1, lineNumber: 1, sku: "A", qty: 2 },
      { orderId: 1, lineNumber: 2, sku: "B", qty: 5 },
      { orderId: 2, lineNumber: 1, sku: "C", qty: 9 },
    ]);
  });

  it("getById matches on the whole key, not on the first column", async () => {
    const row = await repo.getById({ orderId: 1, lineNumber: 2 });
    expect(row.sku).toBe("B");
    expect((await repo.getByIdOrNull({ orderId: 2, lineNumber: 1 }))?.sku).toBe("C");
  });

  it("getById rejects a scalar instead of silently using half the key", async () => {
    await expect(repo.getById(1)).rejects.toThrow(/composite primary key/);
  });

  it("RecordNotFound carries the whole key", async () => {
    await expect(repo.getById({ orderId: 9, lineNumber: 9 })).rejects.toThrow(
      /not found for key \{"orderId":9,"lineNumber":9\}/,
    );
  });

  it("count still works with a composite key", async () => {
    expect(await repo.count()).toBe(3);
    expect(await repo.count({ orderId: 1 })).toBe(2);
  });
});

describe("activeRecord with a composite primary key", () => {
  let engine: AsyncEngine;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    for (const stmt of DDL) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
  });

  it("updates, reloads and deletes exactly one row", async () => {
    const lines = activeRecord(OrderLine, engine.session());
    const repo = new BaseRepository(OrderLine, engine.session());
    await repo.createMany([
      { orderId: 1, lineNumber: 1, sku: "A", qty: 2 },
      { orderId: 1, lineNumber: 2, sku: "B", qty: 5 },
    ]);

    const line = await lines.get({ orderId: 1, lineNumber: 2 });
    expect(line).not.toBeNull();
    await line?.update({ qty: 50 });
    await line?.reload();
    expect(line?.data.qty).toBe(50);
    expect((await repo.getById({ orderId: 1, lineNumber: 1 })).qty).toBe(2);

    expect(await line?.delete()).toBe(1);
    expect(await repo.count()).toBe(1);
  });

  it("save() upserts on the whole key", async () => {
    const lines = activeRecord(OrderLine, engine.session());
    const created = lines.create({ orderId: 3, lineNumber: 1, sku: "D", qty: 1 });
    await created.save();
    created.data = { ...created.data, qty: 42 } as LineRow;
    await created.save();

    const repo = new BaseRepository(OrderLine, engine.session());
    expect(await repo.count()).toBe(1);
    expect((await repo.getById({ orderId: 3, lineNumber: 1 })).qty).toBe(42);
  });
});

describe("single-column primary key stays unchanged", () => {
  it("accepts the bare value", async () => {
    const engine = createEngine("sqlite://:memory:");
    for (const stmt of DDL) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
    const repo = new BaseRepository(Single, engine.session());
    await repo.create({ id: 1, label: "one" });
    expect((await repo.getById(1)).label).toBe("one");
    await expect(repo.getById(2)).rejects.toThrow(RecordNotFound);
    await engine.close();
  });
});
