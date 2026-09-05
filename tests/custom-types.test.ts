import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  BaseRepository,
  Model,
  column,
  createEngine,
  customType,
  getDialect,
  insert,
  select,
  sql,
  update,
} from "../src/index.js";
import { reflectTable, renderOperation } from "../src/migrations/index.js";

/** Money as integer cents — the classic case for a custom column type. */
class Money {
  constructor(readonly cents: bigint) {}
  static fromCents(cents: bigint): Money {
    return new Money(cents);
  }
  plus(other: Money): Money {
    return new Money(this.cents + other.cents);
  }
}

const money = customType<Money, bigint>({
  base: () => column.bigInteger(),
  toDb: (value) => value.cents,
  fromDb: (cents) => Money.fromCents(cents),
});

/** A branded id stored as text. */
type OrderRef = string & { readonly __brand: "OrderRef" };
const orderRef = customType<OrderRef, string>({
  base: () => column.varchar(40),
  toDb: (value) => value,
  fromDb: (value) => value as OrderRef,
});

class Order extends Model {
  static override tablename = "orders";
  id = column.integer().primaryKey();
  reference = orderRef().notNull();
  total = money().notNull();
}

describe("customType — schema", () => {
  it("keeps the base type in the IR and the DDL", () => {
    const ir = reflectTable(Order);
    expect(ir.columns.total?.type.kind).toBe("bigint");
    expect(ir.columns.reference?.type.kind).toBe("varchar");
    const [create] = renderOperation({ kind: "create_table", table: ir }, "postgresql");
    expect(create).toContain('"total" BIGINT NOT NULL');
  });
});

describe("customType — execution", () => {
  let engine: AsyncEngine;
  let repo: BaseRepository<typeof Order>;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    for (const stmt of renderOperation(
      { kind: "create_table", table: reflectTable(Order) },
      "sqlite",
    )) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
    repo = new BaseRepository(Order, engine.session());
  });

  it("round-trips the domain value", async () => {
    const created = await repo.create({
      id: 1,
      reference: "abc" as OrderRef,
      total: new Money(1500n),
    });
    expect(created.total).toBeInstanceOf(Money);
    expect(created.total.cents).toBe(1500n);

    const read = await repo.getById(1);
    expect(read.total.plus(new Money(1n)).cents).toBe(1501n);
  });

  it("stores the base representation, not the object", async () => {
    await repo.create({ id: 1, reference: "abc" as OrderRef, total: new Money(1500n) });
    // biome-ignore lint/suspicious/noExplicitAny: raw row, before coercion.
    const { rows } = await (engine as any).driver.execute("SELECT total FROM orders", []);
    expect(rows[0].total).toBe(1500);
  });

  it("converts a where operand, so a domain value can be compared", async () => {
    await repo.createMany([
      { id: 1, reference: "a" as OrderRef, total: new Money(100n) },
      { id: 2, reference: "b" as OrderRef, total: new Money(900n) },
    ]);
    const found = await repo.list({ total: new Money(900n) } as never);
    expect(found.map((r) => r.id)).toEqual([2]);

    const above = await engine
      .session()
      .execute(select(Order).where({ total: { gt: new Money(500n) } } as never))
      .all();
    expect(above.map((r) => r.id)).toEqual([2]);
  });

  it("converts every element of an IN list", () => {
    const q = select(Order).where({
      total: { in: [new Money(100n), new Money(900n)] },
    } as never);
    const { params } = getDialect("postgresql").compile(
      (q as unknown as { node: never }).node,
    );
    expect(params).toEqual([100n, 900n]);
  });

  it("updates through the codec", async () => {
    await repo.create({ id: 1, reference: "a" as OrderRef, total: new Money(100n) });
    await repo.update({ id: 1 }, { total: new Money(4200n) } as never);
    expect((await repo.getById(1)).total.cents).toBe(4200n);
  });

  it("leaves a SQL expression alone", () => {
    const q = update(Order)
      .set({ total: sql.raw("total + 1") })
      .where({ id: 1 });
    const { sql: text } = getDialect("sqlite").compile(
      (q as unknown as { node: never }).node,
    );
    expect(text).toContain('"total" = total + 1');
  });

  it("passes null through untouched", async () => {
    class Nullable extends Model {
      static override tablename = "nullables";
      id = column.integer().primaryKey();
      amount = money();
    }
    for (const stmt of renderOperation(
      { kind: "create_table", table: reflectTable(Nullable) },
      "sqlite",
    )) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
    const nullables = new BaseRepository(Nullable, engine.session());
    const row = await nullables.create({ id: 1 });
    expect(row.amount).toBeNull();
  });
});
