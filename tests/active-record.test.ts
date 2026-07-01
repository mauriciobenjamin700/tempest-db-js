import { beforeEach, describe, expect, it } from "vitest";
import {
  ActiveRecord,
  type AsyncSession,
  Model,
  activeRecord,
  column,
  createEngine,
  sql,
} from "../src/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  age = column.integer().notNull();
  createdAt = column.datetime().notNull().default(sql.now());
}

const DDL = `CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  age INTEGER NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

describe("active-record (opt-in) over async SQLite", () => {
  let session: AsyncSession;

  beforeEach(async () => {
    const engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL, []);
    session = engine.session();
  });

  it("create + save persists and refreshes data (PK filled by RETURNING)", async () => {
    const users = activeRecord(User, session);
    const u = users.create({ id: 1, name: "Ana", age: 30 });
    await u.save();
    expect(u.data.id).toBe(1);
    expect(u.data.name).toBe("Ana");
    const again = await users.get(1);
    expect(again?.data.name).toBe("Ana");
  });

  it("update writes and merges into data", async () => {
    const users = activeRecord(User, session);
    const u = users.create({ id: 1, name: "Ana", age: 30 });
    await u.save();
    await u.update({ age: 31 });
    expect(u.data.age).toBe(31);
    const reloaded = await users.get(1);
    expect(reloaded?.data.age).toBe(31);
  });

  it("save upserts on primary-key conflict", async () => {
    const users = activeRecord(User, session);
    await users.create({ id: 1, name: "Ana", age: 30 }).save();
    // Second save with same PK overwrites (DO UPDATE).
    const u2 = users.create({ id: 1, name: "Ana II", age: 40 });
    await u2.save();
    const fetched = await users.get(1);
    expect(fetched?.data.name).toBe("Ana II");
    expect(fetched?.data.age).toBe(40);
  });

  it("delete removes the row", async () => {
    const users = activeRecord(User, session);
    const u = users.create({ id: 1, name: "Ana", age: 30 });
    await u.save();
    expect(await u.delete()).toBe(1);
    expect(await users.get(1)).toBeNull();
  });

  it("reload refreshes data from the database", async () => {
    const users = activeRecord(User, session);
    const u = users.create({ id: 1, name: "Ana", age: 30 });
    await u.save();
    // Change it through a separate wrapper, then reload the first.
    await users.wrap({ ...u.data }).update({ age: 99 });
    await u.reload();
    expect(u.data.age).toBe(99);
  });

  it("wrap returns an ActiveRecord instance", async () => {
    const users = activeRecord(User, session);
    const u = users.create({ id: 1, name: "Ana", age: 30 });
    await u.save();
    const wrapped = users.wrap(u.data);
    expect(wrapped).toBeInstanceOf(ActiveRecord);
    expect(wrapped.data.id).toBe(1);
  });

  it("get returns null for a missing id", async () => {
    const users = activeRecord(User, session);
    expect(await users.get(404)).toBeNull();
  });
});
