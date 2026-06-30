/**
 * PostgreSQL DDL rendering — pure unit tests (no live database needed).
 *
 * Guards the dialect-specific rendering that real-Postgres integration once
 * caught the hard way: integer primary keys must auto-increment (SERIAL), and
 * enum columns must get a named `CREATE TYPE`.
 */
import { describe, expect, it } from "vitest";
import { Model, column } from "../src/index.js";
import {
  type Operation,
  reflectTable,
  renderOperation,
} from "../src/migrations/index.js";

class Account extends Model {
  static tablename = "accounts";
  id = column.integer().primaryKey();
  big = column.bigInteger();
  owner = column.text().notNull();
  role = column.enum("admin", "user").notNull();
}

function createSql(): string {
  const op: Operation = { kind: "create_table", table: reflectTable(Account) };
  return renderOperation(op, "postgresql").join("\n");
}

describe("PostgreSQL DDL", () => {
  it("renders a lone integer primary key as SERIAL (auto-increment)", () => {
    const sql = createSql();
    expect(sql).toContain('"id" SERIAL');
    expect(sql).not.toContain('"id" INTEGER');
    // The PRIMARY KEY constraint is still declared.
    expect(sql).toContain('PRIMARY KEY ("id")');
  });

  it("emits a named CREATE TYPE for enum columns", () => {
    const sql = createSql();
    expect(sql).toContain(`CREATE TYPE "accounts_role" AS ENUM ('admin', 'user')`);
    expect(sql).toContain('"role" "accounts_role" NOT NULL');
  });

  it("keeps SQLite integer PK as INTEGER PRIMARY KEY (rowid auto-increment)", () => {
    const op: Operation = { kind: "create_table", table: reflectTable(Account) };
    const sql = renderOperation(op, "sqlite").join("\n");
    expect(sql).toContain('"id" INTEGER');
    expect(sql).not.toContain("SERIAL");
  });
});
