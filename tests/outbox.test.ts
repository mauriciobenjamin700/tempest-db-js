import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  BaseRepository,
  Model,
  OutboxRepository,
  column,
  createEngine,
  outboxModel,
  select,
} from "../src/index.js";
import { reflectTable, renderOperation } from "../src/migrations/index.js";

class OutboxEvent extends outboxModel("outbox") {}

class Order extends Model {
  static override tablename = "orders";
  id = column.integer().primaryKey();
  total = column.integer().notNull();
}

describe("transactional outbox", () => {
  let engine: AsyncEngine;
  let outbox: OutboxRepository<typeof OutboxEvent>;
  let orders: BaseRepository<typeof Order>;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    for (const stmt of [
      ...renderOperation(
        { kind: "create_table", table: reflectTable(OutboxEvent) },
        "sqlite",
      ),
      "CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER NOT NULL)",
    ]) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
    const session = engine.session();
    outbox = new OutboxRepository(OutboxEvent, session);
    orders = new BaseRepository(Order, session);
  });

  it("writes the business row and the event in one transaction", async () => {
    const session = engine.session();
    const tx = {
      orders: new BaseRepository(Order, session),
      outbox: new OutboxRepository(OutboxEvent, session),
    };

    await session.transaction(async () => {
      const order = await tx.orders.create({ id: 1, total: 100 });
      await tx.outbox.publish({ topic: "order.created", payload: { id: order.id } });
    });

    expect(await orders.count()).toBe(1);
    const [event] = await outbox.pending(10);
    expect(event?.topic).toBe("order.created");
    expect(event?.payload).toEqual({ id: 1 });
    expect(event?.status).toBe("pending");
  });

  it("leaves neither row behind when the block fails", async () => {
    const session = engine.session();
    const tx = {
      orders: new BaseRepository(Order, session),
      outbox: new OutboxRepository(OutboxEvent, session),
    };

    await expect(
      session.transaction(async () => {
        await tx.orders.create({ id: 1, total: 100 });
        await tx.outbox.publish({ topic: "order.created", payload: { id: 1 } });
        throw new Error("broker config missing");
      }),
    ).rejects.toThrow("broker config missing");

    expect(await orders.count()).toBe(0);
    expect(await outbox.count()).toBe(0);
  });

  it("holds a delayed event back until it is due", async () => {
    await outbox.publish({ topic: "later", payload: {}, delayMs: 60_000 });
    expect(await outbox.pending(10)).toEqual([]);
    expect(await outbox.pending(10, { now: Date.now() + 61_000 })).toHaveLength(1);
  });

  it("marks events sent", async () => {
    const [event] = await outbox.publish({ topic: "a", payload: {} });
    expect(await outbox.markSent([event?.id as bigint])).toBe(1);
    const stored = await outbox.getById(event?.id as bigint);
    expect(stored.status).toBe("sent");
    expect(stored.sentAt).toBeInstanceOf(Date);
  });

  it("reschedules a failure with backoff and keeps the error", async () => {
    const [event] = await outbox.publish({ topic: "a", payload: {} });
    await outbox.markFailed(event?.id as bigint, new Error("broker down"), {
      retryInMs: 30_000,
    });
    const stored = await outbox.getById(event?.id as bigint);
    expect(stored.status).toBe("pending");
    expect(stored.lastError).toBe("broker down");
    expect(await outbox.pending(10)).toEqual([]);
    expect(await outbox.pending(10, { now: Date.now() + 31_000 })).toHaveLength(1);
  });

  it("gives up permanently when told to", async () => {
    const [event] = await outbox.publish({ topic: "a", payload: {} });
    await outbox.markFailed(event?.id as bigint, "poison", { permanent: true });
    expect((await outbox.getById(event?.id as bigint)).status).toBe("failed");
    expect(await outbox.pending(10)).toEqual([]);
  });

  it("filters by topic", async () => {
    await outbox.publish([
      { topic: "order.created", payload: {} },
      { topic: "user.created", payload: {} },
    ]);
    const due = await outbox.pending(10, { topics: ["user.created"] });
    expect(due.map((e) => e.topic)).toEqual(["user.created"]);
  });

  it("refuses to claim on SQLite, which has no row locking", async () => {
    await outbox.publish({ topic: "a", payload: {} });
    await expect(outbox.claim(10)).rejects.toThrow(/FOR UPDATE/i);
  });

  it("publish of an empty list is a no-op", async () => {
    expect(await outbox.publish([])).toEqual([]);
    expect(await engine.session().execute(select(OutboxEvent)).all()).toEqual([]);
  });
});
