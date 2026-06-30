/**
 * PostgreSQL integration tests — real execution against a live database.
 *
 * Gated on `TEST_DATABASE_URL`: skipped entirely when it is not set, so the
 * default `npm test` (SQLite-only) stays green without a Postgres. CI sets it to
 * a service container; locally, point it at any throwaway Postgres, e.g.:
 *
 *   docker run -d -e POSTGRES_PASSWORD=test -e POSTGRES_DB=tdbjs -p 5433:5432 postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:5433/tdbjs npm test
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AsyncDriver,
  type AsyncEngine,
  Model,
  column,
  createEngine,
  del,
  insert,
  select,
  update,
} from "../src/index.js";
import {
  checkDriftPostgres,
  introspectPostgres,
  reflectTable,
  renderOperation,
} from "../src/migrations/index.js";

const url = process.env.TEST_DATABASE_URL;

class Account extends Model {
  static tablename = "accounts";
  id = column.integer().primaryKey();
  owner = column.text().notNull();
  role = column.enum("admin", "user").notNull();
  balance = column.integer().notNull();
}

describe.skipIf(!url)("PostgreSQL — real execution", () => {
  let engine: AsyncEngine;
  let driver: AsyncDriver;

  beforeAll(async () => {
    engine = createEngine(url as string);
    // The driver is private on the engine; reach it for raw DDL setup only.
    driver = (engine as unknown as { driver: AsyncDriver }).driver;
    await driver.execute("DROP TABLE IF EXISTS accounts CASCADE", []);
    await driver.execute("DROP TYPE IF EXISTS accounts_role", []);
    // Build the schema straight from the model so it matches (clean drift).
    for (const stmt of renderOperation(
      { kind: "create_table", table: reflectTable(Account) },
      "postgresql",
    )) {
      await driver.execute(stmt, []);
    }
  });

  afterAll(async () => {
    await driver.execute("DROP TABLE IF EXISTS accounts CASCADE", []);
    await driver.execute("DROP TYPE IF EXISTS accounts_role", []);
    await engine.close();
  });

  it("inserts and selects with typed filters", async () => {
    const session = engine.session();
    await session
      .execute(
        insert(Account).values([
          { owner: "Ana", role: "admin", balance: 100 },
          { owner: "Beto", role: "user", balance: 50 },
        ]),
      )
      .rowsAffected();

    const admins = await session.execute(select(Account).where({ role: "admin" })).all();
    expect(admins).toHaveLength(1);
    expect(admins[0]?.owner).toBe("Ana");
    expect(admins[0]?.role).toBe("admin");
  });

  it("supports ILIKE on string columns", async () => {
    const session = engine.session();
    const rows = await session
      .execute(select(Account).where({ owner: { ilike: "%an%" } }))
      .all();
    expect(rows.map((r) => r.owner)).toEqual(["Ana"]);
  });

  it("returns inserted rows via RETURNING", async () => {
    const session = engine.session();
    const created = await session
      .execute(
        insert(Account)
          .values({ owner: "Cris", role: "user", balance: 10 })
          .returning(["owner", "balance"]),
      )
      .all();
    expect(created).toEqual([{ owner: "Cris", balance: 10 }]);
  });

  it("updates rows behind the guard and reports the count", async () => {
    const session = engine.session();
    const affected = await session
      .execute(update(Account).set({ balance: 0 }).where({ role: "user" }))
      .rowsAffected();
    expect(affected).toBeGreaterThanOrEqual(2);
  });

  it("commits a transaction (reserved connection)", async () => {
    const session = engine.session();
    await engine.transaction(async (tx) => {
      await tx.execute(
        insert(Account).values({ owner: "TXok", role: "user", balance: 1 }),
      );
    });
    const rows = await session.execute(select(Account).where({ owner: "TXok" })).all();
    expect(rows).toHaveLength(1);
  });

  it("rolls a transaction back when the body throws", async () => {
    const session = engine.session();
    await expect(
      engine.transaction(async (tx) => {
        await tx.execute(
          insert(Account).values({ owner: "TXbad", role: "user", balance: 1 }),
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await session.execute(select(Account).where({ owner: "TXbad" })).all();
    expect(rows).toHaveLength(0);
  });

  it("introspects the live schema and detects no drift for the model", async () => {
    const ir = await introspectPostgres(driver);
    expect(Object.keys(ir.tables)).toContain("accounts");

    const drift = await checkDriftPostgres(driver, [Account]);
    // Other stray tables in the database may produce entries; assert OUR table is clean.
    expect(drift.filter((d) => d.includes("accounts"))).toEqual([]);
  });

  it("deletes rows behind the guard", async () => {
    const session = engine.session();
    const removed = await session
      .execute(del(Account).where({ owner: "Cris" }))
      .rowsAffected();
    expect(removed).toBe(1);
  });
});
