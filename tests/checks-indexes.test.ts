import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  BaseRepository,
  Model,
  check,
  col,
  column,
  createEngine,
  index,
  insert,
  unique,
} from "../src/index.js";
import {
  diffSchema,
  reflectSchema,
  reflectTable,
  renderOperation,
} from "../src/migrations/index.js";
import { checkDriftAsync, introspectSqliteAsync } from "../src/migrations/introspect.js";

class Order extends Model {
  static override tablename = "orders";
  static override tableArgs = () => [
    check(col("total").gte(0)),
    index(["customerId", "createdAt"]),
    index(["reference"], { unique: true, name: "ix_orders_reference" }),
  ];
  id = column.integer().primaryKey();
  customerId = column.integer().notNull();
  createdAt = column.integer().notNull();
  reference = column.varchar(40).notNull();
  total = column.integer().notNull();
}

class Plain extends Model {
  static override tablename = "orders";
  id = column.integer().primaryKey();
  customerId = column.integer().notNull();
  createdAt = column.integer().notNull();
  reference = column.varchar(40).notNull();
  total = column.integer().notNull();
}

describe("check() and index() — IR and DDL", () => {
  it("reflects them into the table IR, with generated names", () => {
    const ir = reflectTable(Order);
    expect(ir.checks.map((c) => c.name)).toEqual(["ck_orders_total"]);
    expect(ir.indexes.map((i) => [i.name, i.columns, i.unique])).toEqual([
      ["ix_orders_customerId_createdAt", ["customerId", "createdAt"], false],
      ["ix_orders_reference", ["reference"], true],
    ]);
  });

  it("renders the CHECK inline and the indexes as their own statements", () => {
    const stmts = renderOperation(
      { kind: "create_table", table: reflectTable(Order) },
      "postgresql",
    );
    expect(stmts[0]).toContain('CONSTRAINT "ck_orders_total" CHECK ("total" >= 0)');
    expect(stmts).toContain(
      'CREATE INDEX "ix_orders_customerId_createdAt" ON "orders" ("customerId", "createdAt")',
    );
    expect(stmts).toContain(
      'CREATE UNIQUE INDEX "ix_orders_reference" ON "orders" ("reference")',
    );
  });

  it("inlines a partial index predicate, and refuses one on MySQL", () => {
    class Partial extends Model {
      static override tablename = "partials";
      static override tableArgs = () => [
        index(["email"], { unique: true, where: { deletedAt: { isNull: true } } }),
      ];
      id = column.integer().primaryKey();
      email = column.varchar(80).notNull();
      deletedAt = column.datetime();
    }
    const table = reflectTable(Partial);
    const pg = renderOperation({ kind: "create_table", table }, "postgresql");
    expect(pg.join("\n")).toContain('WHERE "deletedAt" IS NULL');
    expect(() => renderOperation({ kind: "create_table", table }, "mysql")).toThrow(
      /no partial index/,
    );
  });

  it("uses the column name, not the property name, in the CHECK", () => {
    class Renamed extends Model {
      static override tablename = "renamed";
      static override naming = "snake_case" as const;
      static override tableArgs = () => [check(col("totalAmount").gte(0))];
      id = column.integer().primaryKey();
      totalAmount = column.integer().notNull();
    }
    const [create] = renderOperation(
      { kind: "create_table", table: reflectTable(Renamed) },
      "postgresql",
    );
    expect(create).toContain('CHECK ("total_amount" >= 0)');
  });
});

describe("diff", () => {
  it("adds a check and an index that the current schema lacks", () => {
    const ops = diffSchema(reflectSchema([Plain]), reflectSchema([Order]));
    expect(ops.map((o) => o.kind).sort()).toEqual([
      "add_constraint",
      "create_index",
      "create_index",
    ]);
  });

  it("drops what the models no longer declare", () => {
    const ops = diffSchema(reflectSchema([Order]), reflectSchema([Plain]));
    expect(ops.map((o) => o.kind).sort()).toEqual([
      "drop_constraint",
      "drop_index",
      "drop_index",
    ]);
  });

  it("sees no change between identical schemas", () => {
    expect(diffSchema(reflectSchema([Order]), reflectSchema([Order]))).toEqual([]);
  });

  it("notices a changed index definition", () => {
    class Changed extends Model {
      static override tablename = "orders";
      static override tableArgs = () => [
        check(col("total").gte(0)),
        index(["customerId", "createdAt"], { unique: true }),
        index(["reference"], { unique: true, name: "ix_orders_reference" }),
      ];
      id = column.integer().primaryKey();
      customerId = column.integer().notNull();
      createdAt = column.integer().notNull();
      reference = column.varchar(40).notNull();
      total = column.integer().notNull();
    }
    const ops = diffSchema(reflectSchema([Order]), reflectSchema([Changed]));
    expect(ops.map((o) => o.kind)).toEqual(["drop_index", "create_index"]);
  });
});

describe("execution and introspection on SQLite", () => {
  let engine: AsyncEngine;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    for (const stmt of renderOperation(
      { kind: "create_table", table: reflectTable(Order) },
      "sqlite",
    )) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
  });

  it("enforces the CHECK", async () => {
    const repo = new BaseRepository(Order, engine.session());
    await repo.create({ id: 1, customerId: 1, createdAt: 1, reference: "a", total: 10 });
    await expect(
      repo.create({ id: 2, customerId: 1, createdAt: 1, reference: "b", total: -1 }),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it("enforces the unique index", async () => {
    const repo = new BaseRepository(Order, engine.session());
    await repo.create({ id: 1, customerId: 1, createdAt: 1, reference: "dup", total: 1 });
    await expect(
      repo.create({ id: 2, customerId: 1, createdAt: 1, reference: "dup", total: 1 }),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  it("reads the indexes back, without counting the unique constraints twice", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: async driver for introspection.
    const schema = await introspectSqliteAsync((engine as any).driver);
    const table = schema.tables.orders;
    expect(table?.indexes.map((i) => i.name).sort()).toEqual([
      "ix_orders_customerId_createdAt",
      "ix_orders_reference",
    ]);
    expect(table?.indexes.find((i) => i.name === "ix_orders_reference")?.unique).toBe(
      true,
    );
  });
});

describe("drift", () => {
  it("reports an index the database lacks, and one the model lacks", async () => {
    const engine = createEngine("sqlite://:memory:");
    for (const stmt of renderOperation(
      { kind: "create_table", table: reflectTable(Plain) },
      "sqlite",
    )) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
    // biome-ignore lint/suspicious/noExplicitAny: async driver for drift.
    const missing = await checkDriftAsync((engine as any).driver, "sqlite", [Order]);
    expect(
      missing.some((m) => m.includes('index "orders.ix_orders_reference" is missing')),
    ).toBe(true);

    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(
      'CREATE INDEX "ix_orders_extra" ON "orders" ("customerId")',
      [],
    );
    // biome-ignore lint/suspicious/noExplicitAny: async driver for drift.
    const extra = await checkDriftAsync((engine as any).driver, "sqlite", [Plain]);
    expect(
      extra.some((m) =>
        m.includes('index "orders.ix_orders_extra" exists in the database'),
      ),
    ).toBe(true);
    await engine.close();
  });
});
