import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  BaseRepository,
  Model,
  column,
  columnsOf,
  createEngine,
  notDeleted,
  onlyDeleted,
  select,
  withAudit,
  withSoftDelete,
  withTimestamps,
} from "../src/index.js";
import { reflectTable } from "../src/migrations/ir.js";

class Note extends withSoftDelete(withTimestamps(Model)) {
  static override tablename = "notes";
  id = column.integer().primaryKey();
  title = column.varchar(80).notNull();
}

class Doc extends withAudit(Model, () => column.integer()) {
  static override tablename = "docs";
  id = column.integer().primaryKey();
}

const DDL = `
CREATE TABLE notes (
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deletedAt TEXT,
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL
)`;

describe("model mixins — declaration", () => {
  it("contributes real columns, base columns first", () => {
    expect(Object.keys(columnsOf(Note))).toEqual([
      "createdAt",
      "updatedAt",
      "deletedAt",
      "id",
      "title",
    ]);
  });

  it("lets the actor column type be chosen", () => {
    expect(Object.keys(columnsOf(Doc))).toEqual(["createdBy", "updatedBy", "id"]);
    expect(columnsOf(Doc).createdBy?.type.kind).toBe("integer");
  });

  it("reaches the migration IR like any other column", () => {
    const ir = reflectTable(Note);
    expect(Object.keys(ir.columns)).toContain("createdAt");
    expect(ir.columns.updatedAt?.notNull).toBe(true);
    expect(ir.columns.deletedAt?.notNull).toBe(false);
  });
});

describe("model mixins — execution", () => {
  let engine: AsyncEngine;
  let repo: BaseRepository<typeof Note>;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL, []);
    repo = new BaseRepository(Note, engine.session());
  });

  it("fills createdAt/updatedAt without the call site passing them", async () => {
    const row = await repo.create({ id: 1, title: "first" });
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
    expect(row.deletedAt).toBeNull();
  });

  it("refreshes updatedAt on update and leaves createdAt alone", async () => {
    const created = await repo.create({ id: 1, title: "first" });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await repo.update({ id: 1 }, { title: "second" });
    const after = await repo.getById(1);
    expect(after.title).toBe("second");
    expect(after.createdAt.getTime()).toBe(created.createdAt.getTime());
    expect(after.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  it("notDeleted / onlyDeleted split the table", async () => {
    await repo.create({ id: 1, title: "alive" });
    await repo.create({ id: 2, title: "gone", deletedAt: new Date() });

    const alive = await engine.session().execute(select(Note).where(notDeleted())).all();
    const dead = await engine.session().execute(select(Note).where(onlyDeleted())).all();

    expect(alive.map((r) => r.title)).toEqual(["alive"]);
    expect(dead.map((r) => r.title)).toEqual(["gone"]);
  });
});
