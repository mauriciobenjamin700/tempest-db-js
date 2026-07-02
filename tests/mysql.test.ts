import { describe, expect, it } from "vitest";
import { Model, column, del, getDialect, insert, select, update } from "../src/index.js";
import { reflectTable, renderOperation } from "../src/migrations/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.varchar(80).notNull();
  role = column.enum("admin", "user").notNull();
  active = column.boolean().notNull();
}

const mysql = getDialect("mysql");

describe("MySQL dialect — query compilation", () => {
  it("quotes identifiers with backticks, `?` placeholders", () => {
    expect(mysql.compile(select(User).where({ id: 1 }).node)).toEqual({
      sql: "SELECT * FROM `users` WHERE `id` = ?",
      params: [1],
    });
  });

  it("compiles LIKE for ilike (case-insensitive by default)", () => {
    expect(
      mysql.compile(select(User).where({ name: { ilike: "%a%" } }).node).sql,
    ).toContain("`name` LIKE ?");
  });

  it("compiles UPDATE / DELETE with backticks", () => {
    expect(mysql.compile(update(User).set({ name: "x" }).where({ id: 1 }).node).sql).toBe(
      "UPDATE `users` SET `name` = ? WHERE `id` = ?",
    );
    expect(mysql.compile(del(User).where({ id: 1 }).node).sql).toBe(
      "DELETE FROM `users` WHERE `id` = ?",
    );
  });

  it("upsert uses ON DUPLICATE KEY UPDATE", () => {
    const doNothing = mysql.compile(
      insert(User)
        .values({ id: 1, name: "a", role: "user", active: true })
        .onConflictDoNothing(["id"]).node,
    );
    expect(doNothing.sql).toContain("ON DUPLICATE KEY UPDATE `id` = `id`");

    const doUpdate = mysql.compile(
      insert(User)
        .values({ id: 1, name: "a", role: "user", active: true })
        .onConflictDoUpdate(["id"], { name: "b" }).node,
    );
    expect(doUpdate.sql).toContain("ON DUPLICATE KEY UPDATE `name` = ?");
    // Compiler binds raw values (row values then SET values); the driver encodes
    // booleans → 1/0 at execution, not here.
    expect(doUpdate.params).toEqual([1, "a", "user", true, "b"]);
  });

  it("throws when RETURNING is requested (unsupported on MySQL)", () => {
    expect(() =>
      mysql.compile(
        insert(User).values({ id: 1, name: "a", role: "user", active: true }).returning()
          .node,
      ),
    ).toThrow(/RETURNING is not supported on MySQL/);
  });
});

describe("MySQL DDL rendering", () => {
  it("CREATE TABLE: AUTO_INCREMENT PK, native ENUM, TINYINT(1) boolean", () => {
    const [sql] = renderOperation(
      { kind: "create_table", table: reflectTable(User) },
      "mysql",
    );
    expect(sql).toContain("`id` INT NOT NULL AUTO_INCREMENT");
    expect(sql).toContain("`name` VARCHAR(80) NOT NULL");
    expect(sql).toContain("`role` ENUM('admin', 'user') NOT NULL");
    expect(sql).toContain("`active` TINYINT(1) NOT NULL");
    expect(sql).toContain("PRIMARY KEY (`id`)");
  });

  it("rename table uses RENAME TABLE; alter column uses MODIFY COLUMN", () => {
    expect(
      renderOperation({ kind: "rename_table", from: "a", to: "b" }, "mysql"),
    ).toEqual(["RENAME TABLE `a` TO `b`"]);
    const col = reflectTable(User).columns.name;
    const [alter] = renderOperation(
      // biome-ignore lint/style/noNonNullAssertion: fixture column always present.
      { kind: "alter_column", table: "users", name: "name", from: col!, to: col! },
      "mysql",
    );
    expect(alter).toContain("ALTER TABLE `users` MODIFY COLUMN `name`");
  });
});
