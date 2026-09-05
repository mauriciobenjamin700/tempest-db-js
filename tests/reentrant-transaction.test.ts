import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  BaseRepository,
  Model,
  type SyncEngine,
  column,
  createEngine,
  createSyncEngine,
  insert,
  select,
} from "../src/index.js";

class Order extends Model {
  static override tablename = "orders";
  id = column.integer().primaryKey();
  total = column.integer().notNull();
}

class Item extends Model {
  static override tablename = "items";
  id = column.integer().primaryKey();
  orderId = column.integer().notNull();
}

const DDL = [
  "CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER NOT NULL)",
  "CREATE TABLE items (id INTEGER PRIMARY KEY, orderId INTEGER NOT NULL)",
];

describe("re-entrant transaction (async)", () => {
  let engine: AsyncEngine;
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
    statements.length = 0;
  });

  it("emits one BEGIN and one COMMIT for a nested block", async () => {
    const session = engine.session();
    await session.transaction(async (tx) => {
      await tx.execute(insert(Order).values({ id: 1, total: 10 }));
      await tx.transaction(async (inner) => {
        await inner.execute(insert(Item).values({ id: 1, orderId: 1 }));
      });
    });
    expect(statements.filter((s) => s === "BEGIN")).toHaveLength(1);
    expect(statements.filter((s) => s === "COMMIT")).toHaveLength(1);
    expect(statements.filter((s) => s === "ROLLBACK")).toHaveLength(0);
  });

  it("rolls the outer work back when the inner block throws", async () => {
    const session = engine.session();
    await expect(
      session.transaction(async (tx) => {
        await tx.execute(insert(Order).values({ id: 1, total: 10 }));
        await tx.transaction(async () => {
          throw new Error("inner failed");
        });
      }),
    ).rejects.toThrow("inner failed");

    expect(await engine.session().execute(select(Order)).all()).toEqual([]);
    expect(statements.filter((s) => s === "ROLLBACK")).toHaveLength(1);
  });

  it("commits two repositories on the same session together", async () => {
    const session = engine.session();
    const orders = new BaseRepository(Order, session);
    const items = new BaseRepository(Item, session);

    await session.transaction(async () => {
      await orders.create({ id: 1, total: 10 });
      await items.create({ id: 1, orderId: 1 });
    });

    expect(await orders.count()).toBe(1);
    expect(await items.count()).toBe(1);
    expect(statements.filter((s) => s === "BEGIN")).toHaveLength(1);
  });

  it("discards both repositories' work when the block throws", async () => {
    const session = engine.session();
    const orders = new BaseRepository(Order, session);
    const items = new BaseRepository(Item, session);

    await expect(
      session.transaction(async () => {
        await orders.create({ id: 1, total: 10 });
        await items.create({ id: 1, orderId: 1 });
        throw new Error("business rule failed");
      }),
    ).rejects.toThrow("business rule failed");

    expect(await orders.count()).toBe(0);
    expect(await items.count()).toBe(0);
  });

  it("reports the depth while blocks are open", async () => {
    const session = engine.session();
    expect(session.inTransaction).toBe(false);
    await session.transaction(async (tx) => {
      expect(tx.transactionDepth).toBe(1);
      await tx.transaction(async (inner) => {
        expect(inner.transactionDepth).toBe(2);
        expect(inner.inTransaction).toBe(true);
      });
      expect(tx.transactionDepth).toBe(1);
    });
    expect(session.transactionDepth).toBe(0);
  });

  it("lets a savepoint recover an inner failure without losing the outer work", async () => {
    const session = engine.session();
    let recovered: unknown;
    await session.transaction(async (tx) => {
      await tx.execute(insert(Order).values({ id: 1, total: 10 }));
      await tx
        .beginNested(async (sp) => {
          await sp.execute(insert(Order).values({ id: 2, total: 20 }));
          throw new Error("inner failed");
        })
        .catch((error: unknown) => {
          recovered = error;
        });
      await tx.execute(insert(Item).values({ id: 1, orderId: 1 }));
    });

    expect((recovered as Error).message).toBe("inner failed");

    expect(
      (await engine.session().execute(select(Order)).all()).map((o) => o.id),
    ).toEqual([1]);
    expect(await engine.session().execute(select(Item)).all()).toHaveLength(1);
  });
});

describe("re-entrant transaction (sync)", () => {
  let engine: SyncEngine;
  let statements: string[];

  beforeEach(() => {
    statements = [];
    engine = createSyncEngine("sqlite://:memory:", {
      onQuery: ({ sql }) => statements.push(sql),
    });
    for (const stmt of DDL) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      (engine as any).driver.execute(stmt, []);
    }
    statements.length = 0;
  });

  it("emits one BEGIN/COMMIT and rolls back the whole nest on failure", () => {
    const session = engine.session();
    session.transaction((tx) => {
      tx.execute(insert(Order).values({ id: 1, total: 10 }));
      tx.transaction((inner) => {
        inner.execute(insert(Item).values({ id: 1, orderId: 1 }));
      });
    });
    expect(statements.filter((s) => s === "BEGIN")).toHaveLength(1);

    expect(() =>
      session.transaction((tx) => {
        tx.execute(insert(Order).values({ id: 2, total: 20 }));
        tx.transaction(() => {
          throw new Error("nope");
        });
      }),
    ).toThrow("nope");
    expect(
      engine
        .session()
        .execute(select(Order))
        .all()
        .map((o) => o.id),
    ).toEqual([1]);
  });
});
