import { describe, expect, it } from "vitest";
import { Model, NodeSqliteDriver, column, foreignKey, unique } from "../src/index.js";
import {
  type Operation,
  checkDrift,
  diffSchema,
  emptySchema,
  introspectSqlite,
  invert,
  reflectSchema,
  reflectTable,
  renderOperation,
} from "../src/migrations/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  email = column.varchar(120).notNull().unique();
}

class Post extends Model {
  static override tablename = "posts";
  id = column.integer().primaryKey();
  authorId = column.integer().notNull().references("users.id", { onDelete: "cascade" });
  title = column.text().notNull();
}

class Membership extends Model {
  static override tablename = "memberships";
  userId = column.integer().notNull();
  orgId = column.integer().notNull();
  role = column.varchar(20).notNull();
  static override tableArgs = () => [
    unique("userId", "orgId"),
    foreignKey(["userId"], "users", ["id"], { onDelete: "cascade" }),
  ];
}

describe("reflect — column-level constraints", () => {
  it("captures .unique() on a column", () => {
    const ir = reflectTable(User);
    expect(ir.columns.email?.unique).toBe(true);
    expect(ir.columns.id?.unique).toBe(false);
  });

  it("captures .references() with referential actions", () => {
    const ir = reflectTable(Post);
    expect(ir.columns.authorId?.references).toEqual({
      table: "users",
      column: "id",
      onDelete: "cascade",
      onUpdate: undefined,
    });
  });

  it("throws on a malformed reference string", () => {
    expect(() => column.integer().references("nodot")).toThrow(/table\.column/);
  });
});

describe("reflect — table-level constraints (tableArgs)", () => {
  it("reflects composite unique + foreign key with deterministic names", () => {
    const ir = reflectTable(Membership);
    expect(ir.uniqueConstraints).toEqual([
      { name: "uq_memberships_userId_orgId", columns: ["userId", "orgId"] },
    ]);
    expect(ir.foreignKeys).toEqual([
      {
        name: "fk_memberships_userId",
        columns: ["userId"],
        refTable: "users",
        refColumns: ["id"],
        onDelete: "cascade",
        onUpdate: undefined,
      },
    ]);
  });

  it("rejects mismatched foreignKey column lists", () => {
    expect(() => foreignKey(["a", "b"], "t", ["x"])).toThrow();
  });
});

describe("DDL — CREATE TABLE with constraints", () => {
  it("renders inline UNIQUE + REFERENCES on SQLite", () => {
    const [sql] = renderOperation(
      { kind: "create_table", table: reflectTable(Post) },
      "sqlite",
    );
    expect(sql).toContain(
      '"authorId" INTEGER NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE',
    );
  });

  it("renders a column UNIQUE on PostgreSQL", () => {
    const [sql] = renderOperation(
      { kind: "create_table", table: reflectTable(User) },
      "postgresql",
    );
    expect(sql).toContain('"email" VARCHAR(120) NOT NULL UNIQUE');
  });

  it("renders table-level CONSTRAINT clauses on all dialects", () => {
    const table = reflectTable(Membership);
    for (const dialect of ["sqlite", "postgresql", "mysql"] as const) {
      const [sql] = renderOperation({ kind: "create_table", table }, dialect);
      expect(sql).toContain("CONSTRAINT");
      expect(sql).toMatch(/UNIQUE \(.*userId.*orgId.*\)/);
      expect(sql).toMatch(/FOREIGN KEY \(.*userId.*\) REFERENCES/);
      expect(sql).toContain("ON DELETE CASCADE");
    }
  });
});

describe("diff — table-level constraints", () => {
  class MembershipV2 extends Model {
    static override tablename = "memberships";
    userId = column.integer().notNull();
    orgId = column.integer().notNull();
    role = column.varchar(20).notNull();
    // same fk (unchanged), unique removed
    static override tableArgs = () => [
      foreignKey(["userId"], "users", ["id"], { onDelete: "cascade" }),
    ];
  }

  it("emits a single drop_constraint for a removed unique, leaving the fk alone", () => {
    const ops = diffSchema(reflectSchema([Membership]), reflectSchema([MembershipV2]));
    const drops = ops.filter((o) => o.kind === "drop_constraint");
    expect(drops).toHaveLength(1);
    expect(drops[0]?.constraint.type).toBe("unique");
    // fk is identical → no add/drop for it
    expect(ops.some((o) => o.kind === "add_constraint")).toBe(false);
  });

  it("add_constraint inverts to drop_constraint", () => {
    const add: Operation = {
      kind: "add_constraint",
      table: "memberships",
      constraint: {
        type: "unique",
        constraint: { name: "uq_x", columns: ["userId", "orgId"] },
      },
    };
    expect(invert(add)).toEqual({ ...add, kind: "drop_constraint" });
  });
});

describe("DDL — ALTER for add/drop constraint", () => {
  const uc: Operation = {
    kind: "add_constraint",
    table: "memberships",
    constraint: { type: "unique", constraint: { name: "uq_x", columns: ["a", "b"] } },
  };
  const fk: Operation = {
    kind: "drop_constraint",
    table: "posts",
    constraint: {
      type: "foreignKey",
      constraint: {
        name: "fk_x",
        columns: ["authorId"],
        refTable: "users",
        refColumns: ["id"],
      },
    },
  };

  it("renders ALTER TABLE ADD CONSTRAINT on PostgreSQL", () => {
    expect(renderOperation(uc, "postgresql")[0]).toBe(
      'ALTER TABLE "memberships" ADD CONSTRAINT "uq_x" UNIQUE ("a", "b")',
    );
  });

  it("renders DROP FOREIGN KEY on MySQL", () => {
    expect(renderOperation(fk, "mysql")[0]).toBe(
      "ALTER TABLE `posts` DROP FOREIGN KEY `fk_x`",
    );
  });

  it("throws on SQLite (needs table-rebuild)", () => {
    expect(() => renderOperation(uc, "sqlite")).toThrow(/table-rebuild/);
  });
});

describe("introspect + drift — SQLite", () => {
  function seed(): NodeSqliteDriver {
    const driver = NodeSqliteDriver.open(":memory:");
    driver.execute(
      'CREATE TABLE "users" ("id" INTEGER PRIMARY KEY, "email" TEXT NOT NULL UNIQUE)',
      [],
    );
    driver.execute(
      'CREATE TABLE "posts" ("id" INTEGER PRIMARY KEY, "authorId" INTEGER NOT NULL REFERENCES "users" ("id"), "title" TEXT NOT NULL)',
      [],
    );
    return driver;
  }

  it("reads unique + foreign keys into the IR", () => {
    const driver = seed();
    const ir = introspectSqlite(driver);
    expect(ir.tables.users?.uniqueConstraints).toHaveLength(1);
    expect(ir.tables.posts?.foreignKeys[0]).toMatchObject({
      columns: ["authorId"],
      refTable: "users",
      refColumns: ["id"],
    });
    driver.close();
  });

  it("checkDrift reports no false positives when model matches the db", () => {
    const driver = seed();
    class PostNoTitle extends Model {
      static override tablename = "posts";
      id = column.integer().primaryKey();
      authorId = column.integer().notNull().references("users.id");
      title = column.text().notNull();
    }
    const issues = checkDrift(driver, [User, PostNoTitle]);
    expect(issues).toEqual([]);
    driver.close();
  });

  it("checkDrift flags a foreign key present in the model but missing in the db", () => {
    const driver = NodeSqliteDriver.open(":memory:");
    driver.execute(
      'CREATE TABLE "posts" ("id" INTEGER PRIMARY KEY, "authorId" INTEGER NOT NULL, "title" TEXT NOT NULL)',
      [],
    );
    class PostFk extends Model {
      static override tablename = "posts";
      id = column.integer().primaryKey();
      authorId = column.integer().notNull().references("users.id");
      title = column.text().notNull();
    }
    const issues = checkDrift(driver, [PostFk]);
    expect(issues.some((i) => i.includes("foreign key"))).toBe(true);
    driver.close();
  });
});

describe("MigrationRunner — real SQLite create with constraints", () => {
  it("creates a table with UNIQUE + FK and enforces UNIQUE", () => {
    const driver = NodeSqliteDriver.open(":memory:");
    const ops: Operation[] = [
      { kind: "create_table", table: reflectTable(User) },
      { kind: "create_table", table: reflectTable(Post) },
    ];
    for (const op of ops) {
      for (const sql of renderOperation(op, "sqlite")) driver.execute(sql, []);
    }
    driver.execute('INSERT INTO "users" ("id", "email") VALUES (?, ?)', [1, "a@b.c"]);
    expect(() =>
      driver.execute('INSERT INTO "users" ("id", "email") VALUES (?, ?)', [2, "a@b.c"]),
    ).toThrow();
    driver.close();
  });
});
