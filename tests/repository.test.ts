import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  BaseRepository,
  type InferModel,
  Model,
  RecordNotFound,
  column,
  createEngine,
} from "../src/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.varchar(80).notNull();
  age = column.integer().notNull();
  active = column.boolean().notNull();
}

type UserRow = InferModel<typeof User>;

const DDL =
  "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL, active INTEGER NOT NULL)";

describe("BaseRepository — real async SQLite", () => {
  let engine: AsyncEngine;
  let repo: BaseRepository<typeof User>;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL, []);
    repo = new BaseRepository(User, engine.session());
  });

  it("create returns the inserted row (with generated id)", async () => {
    const row = await repo.create({ name: "Ana", age: 30, active: true });
    expect(row.id).toBeTypeOf("number");
    expect(row.name).toBe("Ana");
    expect(row.active).toBe(true);
  });

  it("getById returns the row; getById missing throws RecordNotFound", async () => {
    const created = await repo.create({ name: "Beto", age: 40, active: false });
    const found = await repo.getById(created.id);
    expect(found.name).toBe("Beto");
    await expect(repo.getById(99999)).rejects.toThrow(RecordNotFound);
    expect(await repo.getByIdOrNull(99999)).toBeNull();
  });

  it("list returns [] when nothing matches (no error)", async () => {
    expect(await repo.list({ name: "nobody" })).toEqual([]);
  });

  it("list + count + exists with filters", async () => {
    await repo.createMany([
      { name: "A", age: 20, active: true },
      { name: "B", age: 30, active: true },
      { name: "C", age: 40, active: false },
    ]);
    expect(await repo.count()).toBe(3);
    expect(await repo.count({ active: true })).toBe(2);
    expect(await repo.exists({ age: { gt: 35 } })).toBe(true);
    expect(await repo.exists({ age: { gt: 100 } })).toBe(false);
    const adults = await repo.list({ age: { gte: 30 } });
    expect(adults.map((u: UserRow) => u.name).sort()).toEqual(["B", "C"]);
  });

  it("update and delete return rows-affected", async () => {
    await repo.createMany([
      { name: "A", age: 20, active: true },
      { name: "B", age: 30, active: true },
    ]);
    const updated = await repo.update({ name: "A" }, { age: 21 });
    expect(updated).toBe(1);
    expect((await repo.first({ name: "A" }))?.age).toBe(21);

    const deleted = await repo.delete({ active: true });
    expect(deleted).toBe(2);
    expect(await repo.count()).toBe(0);
  });

  it("paginate returns a page plus metadata", async () => {
    await repo.createMany(
      Array.from({ length: 5 }, (_, i) => ({ name: `U${i}`, age: 20 + i, active: true })),
    );
    const page1 = await repo.paginate({ page: 1, pageSize: 2, orderBy: "age" });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.pages).toBe(3);
    expect(page1.items.map((u: UserRow) => u.age)).toEqual([20, 21]);

    const page3 = await repo.paginate({ page: 3, pageSize: 2, orderBy: "age" });
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0]?.age).toBe(24);
  });

  it("paginate descending", async () => {
    await repo.createMany([
      { name: "A", age: 10, active: true },
      { name: "B", age: 20, active: true },
    ]);
    const page = await repo.paginate({ orderBy: "age", ascending: false });
    expect(page.items.map((u: UserRow) => u.age)).toEqual([20, 10]);
  });
});
