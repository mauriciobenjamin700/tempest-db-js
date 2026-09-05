/**
 * PostgreSQL integration for CTEs — the recursive walk against a real planner,
 * and the materialization hint, which only PostgreSQL 12+ understands.
 *
 * Gated on `TEST_DATABASE_URL`; uses its own table so it can run in parallel with
 * the other integration files.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AsyncDriver,
  type AsyncEngine,
  BaseRepository,
  Model,
  column,
  createEngine,
  cte,
  cteRecursive,
  join,
  select,
  unionAll,
} from "../src/index.js";
import { reflectTable, renderOperation } from "../src/migrations/index.js";

const url = process.env.TEST_DATABASE_URL;

class Node extends Model {
  static override tablename = "cte_nodes";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  parentId = column.integer();
  label = column.text().notNull();
}

describe.skipIf(!url)("PostgreSQL — CTE", () => {
  let engine: AsyncEngine;
  let driver: AsyncDriver;

  beforeAll(async () => {
    engine = createEngine(url as string);
    driver = (engine as unknown as { driver: AsyncDriver }).driver;
    await driver.execute("DROP TABLE IF EXISTS cte_nodes CASCADE", []);
    for (const stmt of renderOperation(
      { kind: "create_table", table: reflectTable(Node) },
      "postgresql",
    )) {
      await driver.execute(stmt, []);
    }
    await new BaseRepository(Node, engine.session()).createMany([
      { id: 1, parentId: null, label: "root" },
      { id: 2, parentId: 1, label: "a" },
      { id: 3, parentId: 2, label: "a.1" },
      { id: 4, parentId: 3, label: "a.1.1" },
      { id: 5, parentId: null, label: "other root" },
      { id: 6, parentId: 5, label: "outside" },
    ]);
  });

  afterAll(async () => {
    await driver.execute("DROP TABLE IF EXISTS cte_nodes CASCADE", []);
    await engine.close();
  });

  it("walks four levels in one statement", async () => {
    const subtree = cteRecursive("subtree", Node, (self) =>
      unionAll(
        select(Node).where({ id: 1 }),
        join(Node, "n").innerJoin(self, "s", { "n.parentId": "s.id" }).pick("n"),
      ),
    );
    const rows = await engine.session().execute(subtree.select().orderBy("id")).all();
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });

  it("takes the materialization hint", async () => {
    const roots = cte("roots", Node, select(Node).where({ parentId: null }), {
      materialized: true,
    });
    const rows = await engine.session().execute(roots.select().orderBy("id")).all();
    expect(rows.map((r) => r.id)).toEqual([1, 5]);
  });
});
