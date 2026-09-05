/**
 * PostgreSQL integration for transaction characteristics — the part only a real
 * database can show: `serializable` turning write skew into a serialization
 * failure, and `readOnly` making the database itself refuse a write.
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
  select,
} from "../src/index.js";
import { reflectTable, renderOperation } from "../src/migrations/index.js";

const url = process.env.TEST_DATABASE_URL;

class OnCall extends Model {
  static override tablename = "iso_on_call";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  onCall = column.boolean().notNull();
}

/** A promise plus the handle that settles it, for interleaving two transactions. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
}

describe.skipIf(!url)("PostgreSQL — transaction characteristics", () => {
  let engine: AsyncEngine;
  let driver: AsyncDriver;

  beforeAll(async () => {
    engine = createEngine(url as string);
    driver = (engine as unknown as { driver: AsyncDriver }).driver;
    await driver.execute("DROP TABLE IF EXISTS iso_on_call CASCADE", []);
    for (const stmt of renderOperation(
      { kind: "create_table", table: reflectTable(OnCall) },
      "postgresql",
    )) {
      await driver.execute(stmt, []);
    }
  });

  afterAll(async () => {
    await driver.execute("DROP TABLE IF EXISTS iso_on_call CASCADE", []);
    await engine.close();
  });

  it("turns write skew into a serialization failure under serializable", async () => {
    const repo = new BaseRepository(OnCall, engine.session());
    await repo.delete({ id: { in: [1, 2] } });
    await repo.createMany([
      { id: 1, onCall: true },
      { id: 2, onCall: true },
    ]);

    const bothRead = deferred();
    let readers = 0;

    /** Each doctor checks that someone else is on call, then goes off call. */
    const goOffCall = async (id: number): Promise<void> => {
      const own = createEngine(url as string);
      try {
        await own.session().transaction(
          async (tx) => {
            const rows = await tx.execute(select(OnCall).where({ onCall: true })).all();
            expect(rows.length).toBeGreaterThanOrEqual(2);
            readers += 1;
            if (readers === 2) bothRead.resolve();
            await bothRead.promise;
            await new BaseRepository(OnCall, tx).update({ id }, { onCall: false });
          },
          { isolation: "serializable" },
        );
      } finally {
        await own.close();
      }
    };

    const results = await Promise.allSettled([goOffCall(1), goOffCall(2)]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
      /serialize|serialization/i,
    );

    const left = await new BaseRepository(OnCall, engine.session()).count({
      onCall: true,
    });
    expect(left).toBe(1);
  });

  it("makes the database refuse a write in a read-only block", async () => {
    await expect(
      engine.session().transaction(
        async (tx) => {
          await new BaseRepository(OnCall, tx).create({ id: 99, onCall: true });
        },
        { readOnly: true },
      ),
    ).rejects.toThrow(/read-only transaction/i);
  });
});
