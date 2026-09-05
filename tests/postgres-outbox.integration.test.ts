/**
 * PostgreSQL integration for the outbox relay — the claim path, whose whole point
 * is behavior a single process cannot show: two relays running at once must take
 * **disjoint** batches.
 *
 * Gated on `TEST_DATABASE_URL`; uses its own table so it can run in parallel with
 * the other integration files.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AsyncDriver,
  type AsyncEngine,
  OutboxRepository,
  createEngine,
  outboxModel,
} from "../src/index.js";
import { reflectTable, renderOperation } from "../src/migrations/index.js";

const url = process.env.TEST_DATABASE_URL;

class RelayEvent extends outboxModel("relay_outbox") {}

describe.skipIf(!url)("PostgreSQL — outbox relay", () => {
  let engine: AsyncEngine;
  let driver: AsyncDriver;
  let outbox: OutboxRepository<typeof RelayEvent>;

  beforeAll(async () => {
    engine = createEngine(url as string);
    driver = (engine as unknown as { driver: AsyncDriver }).driver;
    await driver.execute("DROP TABLE IF EXISTS relay_outbox CASCADE", []);
    for (const stmt of renderOperation(
      { kind: "create_table", table: reflectTable(RelayEvent) },
      "postgresql",
    )) {
      await driver.execute(stmt, []);
    }
    outbox = new OutboxRepository(RelayEvent, engine.session());
  });

  afterAll(async () => {
    await driver.execute("DROP TABLE IF EXISTS relay_outbox CASCADE", []);
    await engine.close();
  });

  it("hands two concurrent relays disjoint batches", async () => {
    await outbox.delete({});
    await outbox.publish(
      Array.from({ length: 10 }, (_, i) => ({ topic: "t", payload: { i } })),
    );

    /** One relay: claim a batch inside its own transaction. */
    const relay = async (): Promise<bigint[]> => {
      const own = createEngine(url as string);
      try {
        return await own
          .session()
          .transaction(async (tx) =>
            (await new OutboxRepository(RelayEvent, tx).claim(5)).map((e) => e.id),
          );
      } finally {
        await own.close();
      }
    };

    const [a, b] = await Promise.all([relay(), relay()]);
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    expect(new Set([...a, ...b]).size).toBe(10);
  });

  it("increments attempts on claim and confirms with markSent", async () => {
    await outbox.delete({});
    const [event] = await outbox.publish({ topic: "t", payload: {} });
    const claimed = await engine
      .session()
      .transaction(async (tx) => new OutboxRepository(RelayEvent, tx).claim(5));

    expect(claimed.map((e) => e.id)).toEqual([event?.id]);
    expect(claimed[0]?.attempts).toBe(1);
    expect(claimed[0]?.status).toBe("sending");

    await outbox.markSent(claimed.map((e) => e.id));
    expect((await outbox.getById(event?.id as bigint)).status).toBe("sent");
  });

  it("does not claim an event that is backing off", async () => {
    await outbox.delete({});
    const [event] = await outbox.publish({ topic: "t", payload: {} });
    await outbox.markFailed(event?.id as bigint, new Error("broker down"), {
      retryInMs: 60_000,
    });
    const claimed = await engine
      .session()
      .transaction(async (tx) => new OutboxRepository(RelayEvent, tx).claim(5));
    expect(claimed).toEqual([]);
  });
});
