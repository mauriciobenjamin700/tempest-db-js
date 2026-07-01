import { describe, expectTypeOf, it } from "vitest";
import { type InferModel, Model, column, join } from "../src/index.js";

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

type RowOf<B> = B extends { readonly __row: infer R } ? R : never;

describe("Phase 5 — join result types", () => {
  it("innerJoin yields a composite keyed by alias", () => {
    const q = join(User, "user").innerJoin(Order, "order", { "user.id": "order.userId" });
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{ user: UserRow; order: OrderRow }>();
  });

  it("leftJoin makes the joined side nullable", () => {
    const q = join(User, "user").leftJoin(Order, "order", { "user.id": "order.userId" });
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{
      user: UserRow;
      order: OrderRow | null;
    }>();
  });

  it("supports chaining multiple joins", () => {
    const q = join(User, "user")
      .innerJoin(Order, "order", { "user.id": "order.userId" })
      .leftJoin(User, "ref", { "order.userId": "ref.id" });
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{
      user: UserRow;
      order: OrderRow;
      ref: UserRow | null;
    }>();
  });
});

describe("Phase 5 — on/where/orderBy refs are typed", () => {
  it("rejects an unknown column on the existing side of `on`", () => {
    // @ts-expect-error - `user.bogus` is not a column
    join(User, "user").innerJoin(Order, "order", { "user.bogus": "order.userId" });
  });

  it("rejects an unknown column on the joined side of `on`", () => {
    // @ts-expect-error - `order.bogus` is not a column
    join(User, "user").innerJoin(Order, "order", { "user.id": "order.bogus" });
  });

  it("rejects an unknown ref in where", () => {
    const q = join(User, "user").innerJoin(Order, "order", { "user.id": "order.userId" });
    // @ts-expect-error - `order.bogus` is not a valid alias.column
    q.where({ "order.bogus": "x" });
  });

  it("rejects an unknown ref in orderBy", () => {
    const q = join(User, "user").innerJoin(Order, "order", { "user.id": "order.userId" });
    // @ts-expect-error - `nope.id` is not a known alias
    q.orderBy("nope.id");
  });

  it("accepts valid refs", () => {
    join(User, "user")
      .innerJoin(Order, "order", { "user.id": "order.userId" })
      .where({ "order.status": "paid" })
      .orderBy("order.amount", "desc");
  });
});

describe("Phase 5 — operators typed per join column", () => {
  it("accepts ordered operators on a numeric join column", () => {
    join(User, "user")
      .innerJoin(Order, "order", { "user.id": "order.userId" })
      .where({ "order.amount": { gte: 100, lt: 500 } });
  });

  it("accepts string operators on a string join column", () => {
    join(User, "user")
      .innerJoin(Order, "order", { "user.id": "order.userId" })
      .where({ "order.status": { like: "%paid%" }, "user.name": { ilike: "%ben%" } });
  });

  it("accepts bare-value shorthand (eq) mixed with operator objects", () => {
    join(User, "user")
      .innerJoin(Order, "order", { "user.id": "order.userId" })
      .where({ "user.id": 1, "order.amount": { gt: 0 } });
  });

  it("rejects `like` on a numeric join column", () => {
    const q = join(User, "user").innerJoin(Order, "order", {
      "user.id": "order.userId",
    });
    // @ts-expect-error - like is not valid on a number column
    q.where({ "order.amount": { like: "%x%" } });
  });

  it("rejects `gt` on a string join column", () => {
    const q = join(User, "user").innerJoin(Order, "order", {
      "user.id": "order.userId",
    });
    // @ts-expect-error - gt is not valid on a string column
    q.where({ "order.status": { gt: "a" } });
  });

  it("rejects a wrong-typed eq value", () => {
    const q = join(User, "user").innerJoin(Order, "order", {
      "user.id": "order.userId",
    });
    // @ts-expect-error - amount is a number, not a string
    q.where({ "order.amount": "lots" });
  });
});
