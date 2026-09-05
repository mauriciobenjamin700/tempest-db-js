import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  BaseRepository,
  Model,
  auditLogModel,
  clearSignals,
  column,
  createEngine,
  diffSnapshots,
  enableAudit,
  select,
} from "../src/index.js";
import { reflectTable, renderOperation } from "../src/migrations/index.js";

class AuditLog extends auditLogModel("audit_log") {}

class Order extends Model {
  static override tablename = "orders";
  id = column.integer().primaryKey();
  total = column.integer().notNull();
  note = column.varchar(80);
  secret = column.varchar(80);
}

describe("audit log", () => {
  let engine: AsyncEngine;
  let orders: BaseRepository<typeof Order>;
  let log: BaseRepository<typeof AuditLog>;
  let disable: () => void;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    for (const stmt of [
      ...renderOperation(
        { kind: "create_table", table: reflectTable(AuditLog) },
        "sqlite",
      ),
      "CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER NOT NULL, note TEXT, secret TEXT)",
    ]) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
    const session = engine.session();
    orders = new BaseRepository(Order, session);
    log = new BaseRepository(AuditLog, session);
    disable = enableAudit(Order, {
      log: AuditLog,
      actor: () => "user-1",
      exclude: ["secret"],
    });
  });

  afterEach(() => {
    disable();
    clearSignals();
  });

  it("records an insert with every column and the actor", async () => {
    await orders.create({ id: 1, total: 10, note: "a", secret: "hide" });
    const [entry] = await log.list();
    expect(entry?.tableName).toBe("orders");
    expect(entry?.action).toBe("insert");
    expect(entry?.actor).toBe("user-1");
    expect(entry?.rowKey).toEqual({ id: 1 });
    expect(entry?.changes.total).toEqual([null, 10]);
    expect(entry?.changes.secret).toBeUndefined();
  });

  it("records only the changed columns on update", async () => {
    await orders.create({ id: 1, total: 10, note: "a" });
    await orders.update({ id: 1 }, { total: 20 });

    const entries = await log.list({ action: "update" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.changes).toEqual({ total: [10, 20] });
  });

  it("writes nothing when an update changes nothing", async () => {
    await orders.create({ id: 1, total: 10 });
    await orders.update({ id: 1 }, { total: 10 });
    expect(await log.count({ action: "update" })).toBe(0);
  });

  it("records a delete with the row as it was", async () => {
    await orders.create({ id: 1, total: 10, note: "gone" });
    await orders.delete({ id: 1 });
    const [entry] = await log.list({ action: "delete" });
    expect(entry?.changes.note).toEqual(["gone", null]);
  });

  it("rolls the entry back with the change", async () => {
    const session = engine.session();
    const scoped = new BaseRepository(Order, session);
    await expect(
      session.transaction(async () => {
        await scoped.create({ id: 1, total: 10 });
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");

    expect(await orders.count()).toBe(0);
    expect(await engine.session().execute(select(AuditLog)).all()).toEqual([]);
  });

  it("stops when disabled", async () => {
    disable();
    await orders.create({ id: 2, total: 5 });
    expect(await log.count()).toBe(0);
  });
});

describe("diffSnapshots", () => {
  it("reports only what differs, comparing encoded values", () => {
    expect(diffSnapshots({ a: 1, b: "x" }, { a: 2, b: "x" })).toEqual({ a: [1, 2] });
    expect(diffSnapshots({ a: 1 }, { a: 1 })).toEqual({});
    expect(diffSnapshots({ a: 1 }, { a: 1, b: "new" })).toEqual({ b: [null, "new"] });
    expect(diffSnapshots({ a: null }, { a: undefined })).toEqual({});
  });
});
