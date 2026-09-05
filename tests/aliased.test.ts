import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  Model,
  aliasOf,
  aliased,
  check,
  col,
  column,
  createEngine,
  exists,
  getDialect,
  insert,
  join,
  scalar,
  select,
  unique,
} from "../src/index.js";
import { reflectTable } from "../src/migrations/index.js";

class Employee extends Model {
  static override tablename = "employees";
  static override tableArgs = () => [unique("email"), check(col("salary").gte(0))];
  id = column.integer().primaryKey();
  managerId = column.integer();
  email = column.varchar(80).notNull();
  name = column.varchar(40).notNull();
  salary = column.integer().notNull();
}

const DDL = `CREATE TABLE employees (
  id INTEGER PRIMARY KEY, managerId INTEGER, email TEXT NOT NULL,
  name TEXT NOT NULL, salary INTEGER NOT NULL)`;

function compile(builder: unknown, dialect: "sqlite" | "postgresql" | "mysql") {
  return getDialect(dialect).compile((builder as { node: never }).node);
}

describe("aliased", () => {
  it("reads the same columns under another table name", () => {
    const sub = aliased(Employee, "sub");
    expect(sub.tablename).toBe("sub");
    expect(aliasOf(sub)).toBe(Employee);
    expect(aliasOf(Employee)).toBeNull();
    const { sql } = compile(select(sub, ["id"]), "postgresql");
    expect(sql).toBe('SELECT "id" FROM "employees" AS "sub"');
  });

  it("does not carry the table constraints into a migration", () => {
    const ir = reflectTable(aliased(Employee, "sub"));
    expect(ir.uniqueConstraints).toEqual([]);
    expect(ir.checks).toEqual([]);
    expect(Object.keys(ir.columns)).toContain("salary");
  });

  it("makes a correlated subquery over the same table expressible", () => {
    const sub = aliased(Employee, "sub");
    const { sql } = compile(
      select(Employee).where(
        exists(select(sub).where({ managerId: col("employees.id") })),
      ),
      "postgresql",
    );
    expect(sql).toContain(
      'EXISTS (SELECT * FROM "employees" AS "sub" WHERE "managerId" = "employees"."id")',
    );
  });

  it("joins a model against itself", () => {
    const { sql } = compile(
      join(Employee, "e").innerJoin(aliased(Employee, "boss"), "m", {
        "e.managerId": "m.id",
      }),
      "sqlite",
    );
    expect(sql).toContain('JOIN "employees" AS "m"');
  });
});

describe("aliased — execution", () => {
  let engine: AsyncEngine;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL, []);
    await engine.session().execute(
      insert(Employee).values([
        { id: 1, managerId: null, email: "a@x", name: "chefe", salary: 100 },
        { id: 2, managerId: 1, email: "b@x", name: "gerente", salary: 80 },
        { id: 3, managerId: 2, email: "c@x", name: "analista", salary: 50 },
        { id: 4, managerId: null, email: "d@x", name: "sozinho", salary: 60 },
      ]),
    );
  });

  it("finds the rows that have a subordinate", async () => {
    const sub = aliased(Employee, "sub");
    const rows = await engine
      .session()
      .execute(
        select(Employee)
          .where(exists(select(sub).where({ managerId: col("employees.id") })))
          .orderBy("id"),
      )
      .all();
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it("compares a row against a scalar subquery over the same table", async () => {
    const sub = aliased(Employee, "sub");
    const managerSalary = select(sub, ["salary"])
      .where({ id: col("employees.managerId") })
      .asSubquery("salary");

    const rows = await engine
      .session()
      .execute(select(Employee).where(scalar(managerSalary).gt(70)).orderBy("id"))
      .all();
    // 2's manager earns 100, 3's earns 80; 1 and 4 have no manager, so the
    // subquery is NULL and the comparison is not true.
    expect(rows.map((r) => r.id)).toEqual([2, 3]);
  });
});
