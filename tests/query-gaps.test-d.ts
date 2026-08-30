import { describe, expectTypeOf, it } from "vitest";
import {
  type InferModel,
  Model,
  column,
  createSyncEngine,
  insert,
  select,
  sql,
  update,
} from "../src/index.js";

class ApiKey extends Model {
  static override tablename = "api_keys";
  id = column.integer().primaryKey();
  consumerName = column.text().name("consumer_name").notNull();
  scopes = column.array(column.text()).notNull();
  quotas = column.array(column.integer());
}

describe("column.array inference", () => {
  it("infers T[] from the element column", () => {
    expectTypeOf<InferModel<typeof ApiKey>["scopes"]>().toEqualTypeOf<string[]>();
    expectTypeOf<InferModel<typeof ApiKey>["quotas"]>().toEqualTypeOf<number[] | null>();
  });

  it("keeps the property name in the row despite the column rename", () => {
    expectTypeOf<InferModel<typeof ApiKey>["consumerName"]>().toEqualTypeOf<string>();
  });
});

describe("operators typed per column kind", () => {
  it("accepts array operators on an array column", () => {
    select(ApiKey).where({ scopes: { contains: ["send"], overlaps: ["read"] } });
    select(ApiKey).where({ quotas: { containedBy: [1, 2] } });
  });

  it("accepts ieq on a string column", () => {
    select(ApiKey).where({ consumerName: { ieq: "acme" } });
  });

  it("rejects ieq on a number column", () => {
    // @ts-expect-error - `ieq` is a string operator
    select(ApiKey).where({ id: { ieq: 1 } });
  });

  it("rejects array operators on a scalar column", () => {
    // @ts-expect-error - `contains` needs an array column
    select(ApiKey).where({ consumerName: { contains: ["a"] } });
  });
});

describe("SQL expressions as write values", () => {
  it("accepts a sql expression where the column type is expected", () => {
    update(ApiKey)
      .set({ id: sql.raw("id + 1") })
      .where({ id: 1 });
    update(ApiKey)
      .set({ id: sql.expr`id + ${1}` })
      .where({ id: 1 });
  });

  it("still rejects an arbitrary object", () => {
    update(ApiKey)
      // @ts-expect-error - a bare object is not a column value
      .set({ id: { raw: "id + 1" } })
      .where({ id: 1 });
  });
});

describe("locking and conflict predicates", () => {
  it("keeps the row type through forUpdate", () => {
    const locked = select(ApiKey).forUpdate({ skipLocked: true });
    expectTypeOf(locked.__row).toEqualTypeOf<InferModel<typeof ApiKey>>();
  });

  it("types the conflict predicate against the row", () => {
    insert(ApiKey)
      .values({ consumerName: "a", scopes: [], quotas: null })
      .onConflictDoNothing(["consumerName"], { where: { quotas: { isNull: false } } });
  });

  it("rejects a conflict predicate on a non-column", () => {
    insert(ApiKey)
      .values({ consumerName: "a", scopes: [], quotas: null })
      // @ts-expect-error - `bogus` is not a column
      .onConflictDoNothing(["consumerName"], { where: { bogus: 1 } });
  });
});

describe("session.raw", () => {
  it("returns the caller's row type", async () => {
    const session = createSyncEngine("sqlite://:memory:").session();
    expectTypeOf(session.raw<{ n: number }>("SELECT 1 AS n").all()).toEqualTypeOf<
      { n: number }[]
    >();
  });
});
