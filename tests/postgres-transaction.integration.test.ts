/**
 * PostgreSQL integration for re-entrant transactions — the pooled path, where the
 * block pins one connection and a nested call has to join it instead of issuing a
 * second BEGIN (which postgres.js rejects).
 *
 * Gated on `TEST_DATABASE_URL`; uses its own table so it can run in parallel with
 * the other integration files.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AsyncDriver,
  type AsyncEngine,
  BaseRepository,
  Model,
  column,
  createEngine,
} from "../src/index.js";
import { reflectTable, renderOperation } from "../src/migrations/index.js";

const url = process.env.TEST_DATABASE_URL;

class TxOrder extends Model {
  static override tablename = "tx_orders";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  total = column.integer().notNull();
}

describe.skipIf(!url)("PostgreSQL — re-entrant transactions", () => {
  let engine: AsyncEngine;
  let driver: AsyncDriver;
  const statements: string[] = [];

  beforeAll(async () => {
    engine = createEngine(url as string, {
      onQuery: ({ sql }) => statements.push(sql),
    });
    driver = (engine as unknown as { driver: AsyncDriver }).driver;
    await driver.execute("DROP TABLE IF EXISTS tx_orders CASCADE", []);
    for (const stmt of renderOperation(
      { kind: "create_table", table: reflectTable(TxOrder) },
      "postgresql",
    )) {
      await driver.execute(stmt, []);
    }
  });

  afterAll(async () => {
    await driver.execute("DROP TABLE IF EXISTS tx_orders CASCADE", []);
    await engine.close();
  });

  it("issues one BEGIN/COMMIT for a nested block on a pooled driver", async () => {
    statements.length = 0;
    const session = engine.session();
    await session.transaction(async (tx) => {
      const orders = new BaseRepository(TxOrder, tx);
      await orders.create({ id: 1, total: 10 });
      await tx.transaction(async (inner) => {
        await new BaseRepository(TxOrder, inner).create({ id: 2, total: 20 });
      });
    });
    expect(statements.filter((s) => s === "BEGIN")).toHaveLength(1);
    expect(statements.filter((s) => s === "COMMIT")).toHaveLength(1);

    const repo = new BaseRepository(TxOrder, engine.session());
    expect(await repo.count()).toBe(2);
    await repo.delete({ id: { in: [1, 2] } });
  });

  it("recovers an inner failure through a savepoint, keeping the outer work", async () => {
    const session = engine.session();
    let recovered: unknown;
    await session.transaction(async (tx) => {
      const orders = new BaseRepository(TxOrder, tx);
      await orders.create({ id: 10, total: 100 });
      await tx
        .beginNested(async (sp) => {
          await new BaseRepository(TxOrder, sp).create({ id: 11, total: 110 });
          throw new Error("inner failed");
        })
        .catch((error: unknown) => {
          recovered = error;
        });
      await orders.create({ id: 12, total: 120 });
    });

    expect((recovered as Error).message).toBe("inner failed");
    const repo = new BaseRepository(TxOrder, engine.session());
    expect(await repo.getByIdOrNull(11)).toBeNull();
    expect(await repo.getByIdOrNull(10)).not.toBeNull();
    expect(await repo.getByIdOrNull(12)).not.toBeNull();
    await repo.delete({ id: { in: [10, 12] } });
  });

  it("rolls the whole nest back when the inner block throws", async () => {
    const session = engine.session();
    await expect(
      session.transaction(async (tx) => {
        await new BaseRepository(TxOrder, tx).create({ id: 3, total: 30 });
        await tx.transaction(async () => {
          throw new Error("inner failed");
        });
      }),
    ).rejects.toThrow("inner failed");

    const repo = new BaseRepository(TxOrder, engine.session());
    expect(await repo.getByIdOrNull(3)).toBeNull();
  });
});
