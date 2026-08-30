import { describe, expect, it } from "vitest";
import {
  type InferModel,
  Model,
  type SyncSession,
  and,
  col,
  column,
  createSyncEngine,
  fn,
  getDialect,
  insert,
  join,
  select,
  val,
} from "../src/index.js";

class Order extends Model {
  static override tablename = "orders";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  customerEmail = column.text().notNull();
  total = column.integer().notNull();
  paid = column.integer().notNull();
}

class Customer extends Model {
  static override tablename = "customers";
  id = column.integer().primaryKey();
  email = column.text().notNull();
}

type OrderRow = InferModel<typeof Order>;

const pg = getDialect("postgresql");
const sqlite = getDialect("sqlite");
const mysql = getDialect("mysql");

function session(): SyncSession {
  const s = createSyncEngine("sqlite://:memory:").session();
  s.raw(
    `CREATE TABLE orders (
       id INTEGER PRIMARY KEY,
       customer_email TEXT NOT NULL,
       total INTEGER NOT NULL,
       paid INTEGER NOT NULL
     )`,
  );
  const rows: [number, string, number, number][] = [
    [1, "Ana@Example.com", 100, 100],
    [2, "beto@example.com", 200, 50],
    [3, "  carla@example.com  ", 50, 90],
  ];
  for (const [id, customerEmail, total, paid] of rows) {
    s.execute(insert(Order).values({ id, customerEmail, total, paid }));
  }
  return s;
}

describe("column vs column", () => {
  it("compares two columns without binding either", () => {
    const q = select(Order).where(col<OrderRow>("total").gt(col<OrderRow>("paid")));
    expect(pg.compile(q.node)).toEqual({
      sql: 'SELECT * FROM "orders" WHERE "total" > "paid"',
      params: [],
    });
  });

  it("goes through the column-name map", () => {
    const q = select(Order).where(col<OrderRow>("customerEmail").ne(col<OrderRow>("id")));
    expect(pg.compile(q.node).sql).toContain('"customer_email" <> "id"');
  });

  it("binds a plain operand", () => {
    const q = select(Order).where(col<OrderRow>("total").gte(100));
    expect(pg.compile(q.node)).toEqual({
      sql: 'SELECT * FROM "orders" WHERE "total" >= $1',
      params: [100],
    });
  });

  it("finds the underpaid orders against a real database", () => {
    const s = session();
    const rows = s
      .execute(select(Order).where(col<OrderRow>("total").gt(col<OrderRow>("paid"))))
      .all();
    expect(rows.map((r) => r.id)).toEqual([2]);
  });
});

describe("SQL functions", () => {
  it("applies a function to a column and binds the other side", () => {
    const q = select(Order).where(fn.lower("customerEmail").eq(fn.lower(val("A@B.COM"))));
    expect(pg.compile(q.node)).toEqual({
      sql: 'SELECT * FROM "orders" WHERE lower("customer_email") = lower($1)',
      params: ["A@B.COM"],
    });
  });

  it("nests function calls", () => {
    const q = select(Order).where(fn.lower(fn.trim("customerEmail")).eq(val("x")));
    expect(sqlite.compile(q.node).sql).toContain('lower(trim("customer_email")) = ?');
  });

  it("supports coalesce with mixed column and value args", () => {
    const q = select(Order).where(fn.coalesce("paid", val(0)).lt(10));
    expect(pg.compile(q.node)).toEqual({
      sql: 'SELECT * FROM "orders" WHERE coalesce("paid", $1) < $2',
      params: [0, 10],
    });
  });

  it("calls a non-portable function through fn.call", () => {
    const q = select(Order).where(fn.call("date_trunc", val("day"), "id").eq(val("x")));
    expect(pg.compile(q.node).sql).toContain('date_trunc($1, "id") = $2');
  });

  it("rejects a function name that is not a plain identifier", () => {
    expect(() => fn.call("x); DROP TABLE orders; --")).toThrow(/plain SQL function name/);
  });

  it("matches a functional index case-insensitively, portably", () => {
    const s = session();
    const rows = s
      .execute(
        select(Order).where(
          fn.lower("customerEmail").eq(fn.lower(val("ANA@EXAMPLE.COM"))),
        ),
      )
      .all();
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it("trims before comparing", () => {
    const s = session();
    const rows = s
      .execute(select(Order).where(fn.trim("customerEmail").eq("carla@example.com")))
      .all();
    expect(rows.map((r) => r.id)).toEqual([3]);
  });
});

describe("expression operators and their limits", () => {
  it("renders ieq between two expressions", () => {
    const q = select(Order).where(
      col<OrderRow>("customerEmail").ieq(col<OrderRow>("id")),
    );
    expect(pg.compile(q.node).sql).toContain('lower("customer_email") = lower("id")');
  });

  it("renders ilike per dialect", () => {
    const q = select(Order).where(
      col<OrderRow>("customerEmail").ilike(col<OrderRow>("id")),
    );
    expect(pg.compile(q.node).sql).toContain('"customer_email" ILIKE "id"');
    expect(mysql.compile(q.node).sql).toContain("`customer_email` LIKE `id`");
  });

  it("still binds lists and ranges as values", () => {
    expect(pg.compile(select(Order).where(col<OrderRow>("id").in([1, 2])).node)).toEqual({
      sql: 'SELECT * FROM "orders" WHERE "id" IN ($1, $2)',
      params: [1, 2],
    });
    expect(
      pg.compile(select(Order).where(col<OrderRow>("total").between(1, 9)).node).sql,
    ).toContain('"total" BETWEEN $1 AND $2');
    expect(
      pg.compile(select(Order).where(col<OrderRow>("paid").isNull()).node).sql,
    ).toContain('"paid" IS NULL');
  });

  it("refuses an expression inside a bound list, instead of serializing it", () => {
    expect(() => col<OrderRow>("id").in([col<OrderRow>("total")])).toThrow(
      /takes values, not expressions/,
    );
    expect(() => col<OrderRow>("total").between(col<OrderRow>("paid"), 9)).toThrow(
      /takes values, not expressions/,
    );
  });

  it("refuses an expression right-hand side where the operator needs a value", () => {
    const q = select(Order).where({ id: { in: [1] } });
    expect(pg.compile(q.node).params).toEqual([1]);
    const bad = {
      kind: "compare",
      left: { kind: "column", name: "id" },
      op: "isNull",
      right: { kind: "column", name: "paid" },
    };
    const node = { ...select(Order).node, where: bad };
    expect(() => pg.compile(node as never)).toThrow(/takes a value operand/);
  });

  it("composes with and/or", () => {
    const q = select(Order).where(
      and(col<OrderRow>("total").gt(col<OrderRow>("paid")), { id: { gt: 1 } }),
    );
    expect(pg.compile(q.node).sql).toContain('("total" > "paid") AND ("id" > $1)');
  });

  it("qualifies columns inside a join", () => {
    const q = join(Order, "o")
      .innerJoin(Customer, "c", { "o.id": "c.id" })
      .where(col("o.customerEmail").eq(col("c.email")));
    expect(pg.compile(q.node).sql).toContain('"o"."customer_email" = "c"."email"');
  });
});
