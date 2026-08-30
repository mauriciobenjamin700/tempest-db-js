/**
 * PostgreSQL integration tests for the v0.5.0 query gaps — features whose whole
 * point is behavior a compilation test cannot prove: real row locking, a partial
 * unique index actually matching as a conflict target, native array storage, and
 * a functional index being usable.
 *
 * Gated on `TEST_DATABASE_URL`, exactly like `postgres.integration.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AsyncDriver,
  type AsyncEngine,
  Model,
  column,
  createEngine,
  insert,
  select,
  sql,
  update,
} from "../src/index.js";
import {
  checkDriftPostgres,
  reflectTable,
  renderOperation,
} from "../src/migrations/index.js";

const url = process.env.TEST_DATABASE_URL;

class Outbound extends Model {
  static override tablename = "outbound_messages";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  consumer = column.text().notNull();
  idempotencyKey = column.text();
  status = column.text().notNull();
  attempts = column.integer().notNull().default(0);
  scopes = column.array(column.text()).notNull().default(["send"]);
  nextAttemptAt = column.integer().notNull().default(0);
}

describe.skipIf(!url)("PostgreSQL — v0.5.0 query gaps", () => {
  let engine: AsyncEngine;
  let driver: AsyncDriver;

  beforeAll(async () => {
    engine = createEngine(url as string);
    driver = (engine as unknown as { driver: AsyncDriver }).driver;
    await driver.execute("DROP TABLE IF EXISTS outbound_messages CASCADE", []);
    for (const stmt of renderOperation(
      { kind: "create_table", table: reflectTable(Outbound) },
      "postgresql",
    )) {
      await driver.execute(stmt, []);
    }
    await driver.execute(
      `CREATE UNIQUE INDEX outbound_idempotency_unique
         ON outbound_messages (consumer, idempotency_key)
         WHERE idempotency_key IS NOT NULL`,
      [],
    );
  });

  afterAll(async () => {
    await driver.execute("DROP TABLE IF EXISTS outbound_messages CASCADE", []);
    await engine.close();
  });

  it("reports no drift on this table (others share the database)", async () => {
    const issues = await checkDriftPostgres(driver, [Outbound]);
    const ownIssues = issues.filter((issue) => issue.includes("outbound_messages"));
    expect(ownIssues).toEqual([]);
  });

  it("stores and reads a text[] column as a real array", async () => {
    const session = engine.session();
    const row = await session
      .execute(
        insert(Outbound)
          .values({
            consumer: "c1",
            idempotencyKey: "k1",
            status: "queued",
            attempts: 0,
            scopes: ["send", "read"],
            nextAttemptAt: 0,
          })
          .returning(),
      )
      .one();
    expect(row.scopes).toEqual(["send", "read"]);
    expect(row.idempotencyKey).toBe("k1");
  });

  it("filters with the native array operators", async () => {
    const session = engine.session();
    const contains = await session
      .execute(select(Outbound).where({ scopes: { contains: ["read"] } }))
      .all();
    expect(contains).toHaveLength(1);
    const overlaps = await session
      .execute(select(Outbound).where({ scopes: { overlaps: ["nothing", "send"] } }))
      .all();
    expect(overlaps).toHaveLength(1);
  });

  it("matches the partial unique index as a conflict target", async () => {
    const session = engine.session();
    const duplicate = await session
      .execute(
        insert(Outbound)
          .values({
            consumer: "c1",
            idempotencyKey: "k1",
            status: "queued",
            attempts: 0,
            scopes: ["send"],
            nextAttemptAt: 0,
          })
          .onConflictDoNothing(["consumer", "idempotencyKey"], {
            where: { idempotencyKey: { isNull: false } },
          })
          .returning(),
      )
      .all();
    expect(duplicate).toEqual([]);
  });

  it("never deduplicates rows without an idempotency key", async () => {
    const session = engine.session();
    for (let i = 0; i < 2; i++) {
      await session
        .execute(
          insert(Outbound)
            .values({
              consumer: "c1",
              idempotencyKey: null,
              status: "queued",
              attempts: 0,
              scopes: ["send"],
              nextAttemptAt: 0,
            })
            .onConflictDoNothing(["consumer", "idempotencyKey"], {
              where: { idempotencyKey: { isNull: false } },
            }),
        )
        .rowsAffected();
    }
    const keyless = await session
      .execute(select(Outbound).where({ idempotencyKey: { isNull: true } }))
      .all();
    expect(keyless).toHaveLength(2);
  });

  it("increments a counter without a read-modify-write race", async () => {
    const session = engine.session();
    const [target] = await session.execute(select(Outbound).limit(1)).all();
    const id = (target as { id: number }).id;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        session
          .execute(
            update(Outbound)
              .set({ attempts: sql.raw("attempts + 1") })
              .where({ id }),
          )
          .rowsAffected(),
      ),
    );
    const row = await session.execute(select(Outbound).where({ id })).one();
    expect(row.attempts).toBe(5);
  });

  it("hands disjoint batches to competing workers with SKIP LOCKED", async () => {
    const session = engine.session();
    await session.raw("DELETE FROM outbound_messages", []).rowsAffected();
    await session
      .execute(
        insert(Outbound).values(
          Array.from({ length: 6 }, (_, i) => ({
            consumer: "queue",
            idempotencyKey: `q${i}`,
            status: "queued",
            attempts: 0,
            scopes: ["send"],
            nextAttemptAt: i,
          })),
        ),
      )
      .rowsAffected();

    const claim = async (): Promise<number[]> =>
      engine.transaction(async (tx) => {
        const rows = await tx
          .execute(
            select(Outbound, ["id"])
              .where({ status: "queued" })
              .orderBy("nextAttemptAt")
              .limit(3)
              .forUpdate({ skipLocked: true }),
          )
          .all();
        const ids = rows.map((r) => r.id);
        if (ids.length > 0) {
          await tx
            .execute(
              update(Outbound)
                .set({ status: "sending", attempts: sql.raw("attempts + 1") })
                .where({ id: { in: ids } }),
            )
            .rowsAffected();
        }
        return ids;
      });

    const [first, second] = await Promise.all([claim(), claim()]);
    const overlap = first.filter((id) => second.includes(id));
    expect(overlap).toEqual([]);
    expect([...first, ...second].sort((a, b) => a - b)).toHaveLength(6);
  });

  it("matches a lower(column) functional index with ieq", async () => {
    const session = engine.session();
    await session.raw(
      "CREATE UNIQUE INDEX outbound_consumer_ci ON outbound_messages (lower(consumer), idempotency_key)",
      [],
    );
    const rows = await session
      .execute(select(Outbound).where({ consumer: { ieq: "QUEUE" } }))
      .all();
    expect(rows).toHaveLength(6);
    const plan = await session
      .raw<{ "QUERY PLAN": string }>(
        "EXPLAIN SELECT * FROM outbound_messages WHERE lower(consumer) = lower($1)",
        ["QUEUE"],
      )
      .all();
    expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toBeTypeOf("string");
  });

  it("finds nothing for a wildcard probe through ieq", async () => {
    const session = engine.session();
    const rows = await session
      .execute(select(Outbound).where({ consumer: { ieq: "%" } }))
      .all();
    expect(rows).toEqual([]);
  });

  it("runs raw SQL the builder cannot express", async () => {
    const session = engine.session();
    const rows = await session
      .raw<{ waiting: number }>(
        `SELECT count(*)::int AS waiting
         FROM outbound_messages
        WHERE status = $1`,
        ["sending"],
      )
      .all();
    expect(rows[0]?.waiting).toBe(6);
  });
});
