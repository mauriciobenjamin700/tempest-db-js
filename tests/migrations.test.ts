import { describe, expect, it } from "vitest";
import { Model, NodeSqliteDriver, column } from "../src/index.js";
import {
  type Migration,
  MigrationRunner,
  type Operation,
  checkDrift,
  diffSchema,
  emptySchema,
  generateMigration,
  heads,
  introspectSqlite,
  invert,
  reflectSchema,
  reflectTable,
  renderOperation,
  topoOrder,
} from "../src/migrations/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.varchar(80).notNull();
  age = column.integer().notNull();
}

class Post extends Model {
  static override tablename = "posts";
  id = column.uuid().primaryKey();
  title = column.text().notNull();
}

describe("reflectSchema", () => {
  it("reflects models into IR with columns + primary key", () => {
    const ir = reflectSchema([User]);
    expect(ir.tables.users?.name).toBe("users");
    expect(ir.tables.users?.primaryKey).toEqual(["id"]);
    expect(ir.tables.users?.columns.name?.notNull).toBe(true);
    expect(ir.tables.users?.columns.id?.primaryKey).toBe(true);
  });
});

describe("diffSchema", () => {
  it("emits create_table for new tables and add_column for new columns", () => {
    const ops = diffSchema(emptySchema(), reflectSchema([User, Post]));
    expect(ops.filter((o) => o.kind === "create_table")).toHaveLength(2);
  });

  it("detects an added column on an existing table", () => {
    const before = reflectSchema([User]);
    class UserV2 extends Model {
      static override tablename = "users";
      id = column.integer().primaryKey();
      name = column.varchar(80).notNull();
      age = column.integer().notNull();
      email = column.varchar(120);
    }
    const ops = diffSchema(before, reflectSchema([UserV2]));
    expect(ops).toHaveLength(1);
    expect(ops[0]?.kind).toBe("add_column");
  });

  it("reverse diff drops the table", () => {
    const ops = diffSchema(reflectSchema([User]), emptySchema());
    expect(ops[0]?.kind).toBe("drop_table");
  });
});

describe("invert", () => {
  it("inverts create_table to drop_table and back", () => {
    const create: Operation = { kind: "create_table", table: reflectTable(User) };
    expect(invert(create).kind).toBe("drop_table");
    expect(invert(invert(create)).kind).toBe("create_table");
  });
});

describe("renderOperation (DDL)", () => {
  it("renders CREATE TABLE for SQLite and PostgreSQL", () => {
    const op: Operation = { kind: "create_table", table: reflectTable(User) };
    const sqlite = renderOperation(op, "sqlite")[0] ?? "";
    expect(sqlite).toContain('CREATE TABLE "users"');
    expect(sqlite).toContain('"id" INTEGER');
    expect(sqlite).toContain("PRIMARY KEY");

    const pg = renderOperation(op, "postgresql")[0] ?? "";
    expect(pg).toContain('"name" VARCHAR(80) NOT NULL');
  });

  it("renders ALTER TABLE ADD COLUMN", () => {
    const op: Operation = {
      kind: "add_column",
      table: "users",
      column: reflectTable(User).columns.name as never,
    };
    expect(renderOperation(op, "sqlite")[0]).toContain(
      'ALTER TABLE "users" ADD COLUMN "name"',
    );
  });
});

describe("graph (DAG)", () => {
  const nodes = [
    { revision: "c", downRevision: ["b"] },
    { revision: "a", downRevision: [] },
    { revision: "b", downRevision: ["a"] },
  ];

  it("orders topologically (parents first, deterministic)", () => {
    expect(topoOrder(nodes).map((n) => n.revision)).toEqual(["a", "b", "c"]);
  });

  it("finds the head", () => {
    expect(heads(nodes)).toEqual(["c"]);
  });

  it("throws on a cycle", () => {
    expect(() =>
      topoOrder([
        { revision: "x", downRevision: ["y"] },
        { revision: "y", downRevision: ["x"] },
      ]),
    ).toThrow();
  });
});

describe("generateMigration (codegen)", () => {
  it("produces a TS file with up/down and the revision", () => {
    const ops = diffSchema(emptySchema(), reflectSchema([User]));
    const src = generateMigration({
      revision: "abc123",
      downRevision: [],
      label: "create users",
      operations: ops,
    });
    expect(src).toContain('export const revision = "abc123"');
    expect(src).toContain("export const up");
    expect(src).toContain("export const down");
    expect(src).toContain("create_table");
  });
});

describe("MigrationRunner — real SQLite", () => {
  function migrationFor(): Migration {
    const table = reflectTable(User);
    return {
      revision: "m1",
      downRevision: [],
      label: "create users",
      up: (op) => op.createTable(table),
      down: (op) => op.dropTable(table),
    };
  }

  it("upgrades (creates the table) and tracks the revision", () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const runner = new MigrationRunner(driver, "sqlite");
    const ran = runner.upgrade([migrationFor()], "2026-06-29T00:00:00.000Z");
    expect(ran).toEqual(["m1"]);
    expect(runner.applied().has("m1")).toBe(true);

    // table really exists: insert + read back
    driver.execute('INSERT INTO "users" ("id", "name", "age") VALUES (?, ?, ?)', [
      1,
      "Ana",
      30,
    ]);
    const { rows } = driver.execute('SELECT "name" FROM "users" WHERE "id" = ?', [1]);
    expect(rows[0]?.name).toBe("Ana");

    // idempotent: re-running applies nothing
    expect(runner.upgrade([migrationFor()], "2026-06-29T00:00:00.000Z")).toEqual([]);
    driver.close();
  });

  it("downgrades (drops the table) and forgets the revision", () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const runner = new MigrationRunner(driver, "sqlite");
    runner.upgrade([migrationFor()], "2026-06-29T00:00:00.000Z");

    const reverted = runner.downgrade([migrationFor()], 1);
    expect(reverted).toEqual(["m1"]);
    expect(runner.applied().has("m1")).toBe(false);

    // table gone → querying it throws
    expect(() => driver.execute('SELECT * FROM "users"', [])).toThrow();
    driver.close();
  });
});

describe("SQLite batch-mode (recreate_table)", () => {
  class UserOld extends Model {
    static override tablename = "people";
    id = column.integer().primaryKey();
    name = column.varchar(80).notNull();
    age = column.integer().notNull();
  }
  class UserNew extends Model {
    static override tablename = "people";
    id = column.integer().primaryKey();
    name = column.varchar(80).notNull();
    email = column.varchar(120);
  }

  it("rebuilds the table, preserving common-column data and dropping removed columns", () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const runner = new MigrationRunner(driver, "sqlite");

    const m1: Migration = {
      revision: "r1",
      downRevision: [],
      up: (op) => op.createTable(reflectTable(UserOld)),
      down: (op) => op.dropTable(reflectTable(UserOld)),
    };
    runner.upgrade([m1], "2026-06-29T00:00:00.000Z");
    driver.execute('INSERT INTO "people" ("id", "name", "age") VALUES (?, ?, ?)', [
      1,
      "Ana",
      30,
    ]);

    const m2: Migration = {
      revision: "r2",
      downRevision: ["r1"],
      up: (op) => op.recreateTable(reflectTable(UserOld), reflectTable(UserNew)),
      down: (op) => op.recreateTable(reflectTable(UserNew), reflectTable(UserOld)),
    };
    runner.upgrade([m1, m2], "2026-06-29T00:00:01.000Z");

    // common column `name` survived the rebuild
    const { rows } = driver.execute(
      'SELECT "name", "email" FROM "people" WHERE "id" = ?',
      [1],
    );
    expect(rows[0]?.name).toBe("Ana");
    expect(rows[0]?.email).toBeNull();
    // dropped column `age` is gone
    expect(() => driver.execute('SELECT "age" FROM "people"', [])).toThrow();

    driver.close();
  });

  it("renders the SQLite rebuild sequence", () => {
    const stmts = renderOperation(
      { kind: "recreate_table", from: reflectTable(UserOld), to: reflectTable(UserNew) },
      "sqlite",
    );
    expect(stmts[0]).toBe("PRAGMA foreign_keys=off");
    expect(stmts.some((s) => s.startsWith('CREATE TABLE "__new_people"'))).toBe(true);
    expect(
      stmts.some((s) => s.includes('INSERT INTO "__new_people" ("id", "name")')),
    ).toBe(true);
    expect(stmts.some((s) => s === 'ALTER TABLE "__new_people" RENAME TO "people"')).toBe(
      true,
    );
  });
});

describe("introspection + drift (SQLite)", () => {
  it("reports no drift when the DB matches the models", () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const runner = new MigrationRunner(driver, "sqlite");
    runner.upgrade(
      [
        {
          revision: "i1",
          downRevision: [],
          up: (op) => op.createTable(reflectTable(User)),
          down: (op) => op.dropTable(reflectTable(User)),
        },
      ],
      "2026-06-29T00:00:00.000Z",
    );
    expect(checkDrift(driver, [User])).toEqual([]);
    driver.close();
  });

  it("detects a column present in the model but missing in the DB", () => {
    const driver = NodeSqliteDriver.open(":memory:");
    driver.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)", []);
    class UserPlus extends Model {
      static override tablename = "users";
      id = column.integer().primaryKey();
      name = column.varchar(80).notNull();
      age = column.integer().notNull();
    }
    const drift = checkDrift(driver, [UserPlus]);
    expect(drift.some((d) => d.includes("users.age") && d.includes("missing"))).toBe(
      true,
    );
    driver.close();
  });

  it("introspectSqlite reads tables and columns", () => {
    const driver = NodeSqliteDriver.open(":memory:");
    driver.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT NOT NULL)", []);
    const ir = introspectSqlite(driver);
    expect(ir.tables.t?.primaryKey).toEqual(["id"]);
    expect(ir.tables.t?.columns.label?.notNull).toBe(true);
    driver.close();
  });
});
