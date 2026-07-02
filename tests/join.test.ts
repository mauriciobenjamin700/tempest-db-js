import { beforeEach, describe, expect, it } from "vitest";
import {
  type InferModel,
  Model,
  type SyncEngine,
  column,
  createSyncEngine,
  insert,
  join,
} from "../src/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.varchar(80).notNull();
}

class Order extends Model {
  static override tablename = "orders";
  id = column.integer().primaryKey();
  userId = column.integer().notNull();
  amount = column.integer().notNull();
  status = column.varchar(20).notNull();
}

type UserRow = InferModel<typeof User>;
type OrderRow = InferModel<typeof Order>;

const DDL_USERS = "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)";
const DDL_ORDERS =
  "CREATE TABLE orders (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL)";

describe("Phase 5 — joins, real SQLite execution", () => {
  let engine: SyncEngine;

  beforeEach(() => {
    engine = createSyncEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    const driver = (engine as any).driver;
    driver.execute(DDL_USERS, []);
    driver.execute(DDL_ORDERS, []);
    const s = engine.session();
    s.execute(
      insert(User).values([
        { id: 1, name: "Ana" },
        { id: 2, name: "Beto" }, // no orders
      ]),
    );
    s.execute(
      insert(Order).values([
        { id: 10, userId: 1, amount: 100, status: "paid" },
        { id: 11, userId: 1, amount: 50, status: "pending" },
      ]),
    );
  });

  it("innerJoin returns composite rows keyed by alias", () => {
    const rows = engine
      .session()
      .execute(
        join(User, "user")
          .innerJoin(Order, "order", { "user.id": "order.userId" })
          .where({ "order.status": "paid" }),
      )
      .all() as { user: UserRow; order: OrderRow }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.user).toEqual({ id: 1, name: "Ana" });
    expect(rows[0]?.order).toEqual({ id: 10, userId: 1, amount: 100, status: "paid" });
  });

  it("innerJoin excludes rows with no match", () => {
    const rows = engine
      .session()
      .execute(
        join(User, "user").innerJoin(Order, "order", { "user.id": "order.userId" }),
      )
      .all() as { user: UserRow; order: OrderRow }[];
    // Beto has no orders → only Ana's two orders appear
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.user.name === "Ana")).toBe(true);
  });

  it("leftJoin keeps the unmatched left row with a null right side", () => {
    const rows = engine
      .session()
      .execute(
        join(User, "user")
          .leftJoin(Order, "order", { "user.id": "order.userId" })
          .orderBy("user.id"),
      )
      .all() as { user: UserRow; order: OrderRow | null }[];

    // Ana (2 orders) + Beto (null order)
    expect(rows).toHaveLength(3);
    const beto = rows.find((r) => r.user.name === "Beto");
    expect(beto?.order).toBeNull();
    const ana = rows.filter((r) => r.user.name === "Ana");
    expect(ana).toHaveLength(2);
    expect(ana[0]?.order).not.toBeNull();
  });

  it("orders and filters across both tables", () => {
    const rows = engine
      .session()
      .execute(
        join(User, "user")
          .innerJoin(Order, "order", { "user.id": "order.userId" })
          .orderBy("order.amount", "desc"),
      )
      .all() as { user: UserRow; order: OrderRow }[];
    expect(rows.map((r) => r.order.amount)).toEqual([100, 50]);
  });

  it("applies typed operators in the join where (gte + like)", () => {
    const rows = engine
      .session()
      .execute(
        join(User, "user")
          .innerJoin(Order, "order", { "user.id": "order.userId" })
          .where({ "order.amount": { gte: 100 }, "user.name": { like: "An%" } }),
      )
      .all() as { user: UserRow; order: OrderRow }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.order.amount).toBe(100);
  });

  it("supports `in` and `between` operators across the join", () => {
    const rows = engine
      .session()
      .execute(
        join(User, "user")
          .innerJoin(Order, "order", { "user.id": "order.userId" })
          .where({
            "order.status": { in: ["paid", "pending"] },
            "order.amount": { between: [40, 60] },
          }),
      )
      .all() as { user: UserRow; order: OrderRow }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.order.amount).toBe(50);
  });
});
