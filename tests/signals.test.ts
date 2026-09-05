import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  BaseRepository,
  Model,
  type SignalPayload,
  clearSignals,
  column,
  createEngine,
  hasHandlers,
  onSignal,
  select,
} from "../src/index.js";

class Item extends Model {
  static override tablename = "items";
  id = column.integer().primaryKey();
  label = column.varchar(40).notNull();
  qty = column.integer().notNull();
}

class Other extends Model {
  static override tablename = "others";
  id = column.integer().primaryKey();
}

const DDL = [
  "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, qty INTEGER NOT NULL)",
  "CREATE TABLE others (id INTEGER PRIMARY KEY)",
];

describe("repository signals", () => {
  let engine: AsyncEngine;
  let repo: BaseRepository<typeof Item>;
  let statements: string[];

  beforeEach(async () => {
    statements = [];
    engine = createEngine("sqlite://:memory:", {
      onQuery: ({ sql }) => statements.push(sql),
    });
    for (const stmt of DDL) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
    repo = new BaseRepository(Item, engine.session());
  });

  afterEach(() => {
    clearSignals();
  });

  it("fires preSave and postSave around an insert", async () => {
    const seen: string[] = [];
    onSignal(Item, "preSave", ({ row, isInsert }) => {
      seen.push(`pre:${row.label}:${isInsert}`);
    });
    onSignal(Item, "postSave", ({ row, isInsert }) => {
      seen.push(`post:${row.id}:${isInsert}`);
    });

    await repo.create({ id: 1, label: "a", qty: 1 });
    expect(seen).toEqual(["pre:a:true", "post:1:true"]);
  });

  it("fires per row for a batch insert", async () => {
    const rows: number[] = [];
    onSignal(Item, "postSave", ({ row }) => {
      rows.push(row.id);
    });
    await repo.createMany([
      { id: 1, label: "a", qty: 1 },
      { id: 2, label: "b", qty: 2 },
    ]);
    expect(rows).toEqual([1, 2]);
  });

  it("lets preSave veto the write by throwing", async () => {
    onSignal(Item, "preSave", ({ row }) => {
      if (row.qty < 0) throw new Error("qty must not be negative");
    });
    await expect(repo.create({ id: 1, label: "bad", qty: -1 })).rejects.toThrow(
      "qty must not be negative",
    );
    expect(await repo.count()).toBe(0);
  });

  it("fires around an update, with the patched row before and the stored row after", async () => {
    await repo.create({ id: 1, label: "a", qty: 1 });
    const seen: string[] = [];
    onSignal(Item, "preSave", ({ row, isInsert }) => {
      seen.push(`pre:${row.qty}:${isInsert}`);
    });
    onSignal(Item, "postSave", ({ row }) => {
      seen.push(`post:${row.qty}`);
    });

    await repo.update({ id: 1 }, { qty: 9 });
    expect(seen).toEqual(["pre:9:false", "post:9"]);
  });

  it("hands preDelete and postDelete the row as it was", async () => {
    await repo.create({ id: 1, label: "gone", qty: 3 });
    const seen: string[] = [];
    onSignal(Item, "preDelete", ({ row }) => {
      seen.push(`pre:${row.label}`);
    });
    onSignal(Item, "postDelete", ({ row }) => {
      seen.push(`post:${row.label}`);
    });

    expect(await repo.delete({ id: 1 })).toBe(1);
    expect(seen).toEqual(["pre:gone", "post:gone"]);
    expect(await repo.count()).toBe(0);
  });

  it("does not read the rows when nothing is listening", async () => {
    await repo.create({ id: 1, label: "a", qty: 1 });
    statements.length = 0;
    await repo.delete({ id: 1 });
    expect(statements.filter((s) => s.startsWith("SELECT"))).toHaveLength(0);

    onSignal(Item, "preDelete", () => undefined);
    await repo.create({ id: 2, label: "b", qty: 1 });
    statements.length = 0;
    await repo.delete({ id: 2 });
    expect(statements.filter((s) => s.startsWith("SELECT")).length).toBeGreaterThan(0);
  });

  it("runs the handler inside the caller's transaction", async () => {
    const session = engine.session();
    const items = new BaseRepository(Item, session);
    onSignal(Item, "postSave", async ({ session: handlerSession }) => {
      await new BaseRepository(Other, handlerSession).create({ id: 99 });
    });

    await expect(
      session.transaction(async () => {
        await items.create({ id: 1, label: "a", qty: 1 });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    expect(await engine.session().execute(select(Other)).all()).toEqual([]);
    expect(await repo.count()).toBe(0);
  });

  it("scopes handlers per model and unregisters on demand", async () => {
    const calls: string[] = [];
    const off = onSignal(Item, "postSave", () => calls.push("item"));
    onSignal(Other, "postSave", () => calls.push("other"));

    expect(hasHandlers(Item, "postSave")).toBe(true);
    expect(hasHandlers(Item, "preDelete")).toBe(false);

    await repo.create({ id: 1, label: "a", qty: 1 });
    expect(calls).toEqual(["item"]);

    off();
    await repo.create({ id: 2, label: "b", qty: 1 });
    expect(calls).toEqual(["item"]);
    expect(hasHandlers(Item, "postSave")).toBe(false);
  });

  it("clearSignals(model) drops only that model's handlers", async () => {
    onSignal(Item, "postSave", (_payload: SignalPayload<typeof Item>) => undefined);
    onSignal(Other, "postSave", () => undefined);
    clearSignals(Item);
    expect(hasHandlers(Item, "postSave")).toBe(false);
    expect(hasHandlers(Other, "postSave")).toBe(true);
    clearSignals();
    expect(hasHandlers(Other, "postSave")).toBe(false);
  });
});
