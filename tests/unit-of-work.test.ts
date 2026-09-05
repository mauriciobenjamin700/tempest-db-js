import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  BaseRepository,
  Model,
  type Tracked,
  column,
  createEngine,
  select,
} from "../src/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.varchar(40).notNull();
  visits = column.integer().notNull();
  seenAt = column.datetime();
}

class Post extends Model {
  static override tablename = "posts";
  id = column.integer().primaryKey();
  userId = column.integer().notNull();
  title = column.varchar(40).notNull();
}

const DDL = [
  "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, visits INTEGER NOT NULL, seenAt TEXT)",
  "CREATE TABLE posts (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL, title TEXT NOT NULL)",
];

describe("UnitOfWork", () => {
  let engine: AsyncEngine;
  let statements: string[];
  let users: BaseRepository<typeof User>;

  beforeEach(async () => {
    statements = [];
    engine = createEngine("sqlite://:memory:", {
      onQuery: ({ sql }) => statements.push(sql),
    });
    for (const stmt of DDL) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
    users = new BaseRepository(User, engine.session());
    await users.createMany([
      { id: 1, name: "ana", visits: 1 },
      { id: 2, name: "beto", visits: 2 },
    ]);
    statements.length = 0;
  });

  it("returns the same object twice, with one query", async () => {
    const uow = engine.session().unitOfWork();
    const first = await uow.get(User, 1);
    const second = await uow.get(User, 1);

    expect(first).toBe(second);
    expect(statements.filter((s) => s.startsWith("SELECT"))).toHaveLength(1);
  });

  it("writes only what changed, and nothing when nothing did", async () => {
    const uow = engine.session().unitOfWork();
    const user = (await uow.get(User, 1)) as Tracked<{ name: string; visits: number }>;
    expect(await uow.flush()).toEqual({ inserted: 0, updated: 0, deleted: 0 });

    user.visits = 42;
    const result = await uow.flush();
    expect(result.updated).toBe(1);
    expect((await users.getById(1)).visits).toBe(42);
    expect((await users.getById(1)).name).toBe("ana");

    expect(await uow.flush()).toEqual({ inserted: 0, updated: 0, deleted: 0 });
  });

  it("batches many changes into one transaction", async () => {
    const uow = engine.session().unitOfWork();
    const ana = (await uow.get(User, 1)) as Tracked<{ visits: number }>;
    const beto = (await uow.get(User, 2)) as Tracked<{ visits: number }>;
    ana.visits = 10;
    beto.visits = 20;
    uow.add(Post, { id: 1, userId: 1, title: "novo" });

    statements.length = 0;
    const result = await uow.flush();

    expect(result).toEqual({ inserted: 1, updated: 2, deleted: 0 });
    expect(statements.filter((s) => s === "BEGIN")).toHaveLength(1);
    expect(statements.filter((s) => s === "COMMIT")).toHaveLength(1);
  });

  it("inserts before updating, so a new parent exists for its children", async () => {
    const uow = engine.session().unitOfWork();
    uow.add(User, { id: 3, name: "novo", visits: 0 });
    const ana = (await uow.get(User, 1)) as Tracked<{ name: string }>;
    ana.name = "ana renomeada";

    await uow.flush();
    expect(await users.count()).toBe(3);
    expect((await users.getById(1)).name).toBe("ana renomeada");
  });

  it("deletes what was removed, and forgets a row added then removed", async () => {
    const uow = engine.session().unitOfWork();
    const beto = await uow.get(User, 2);
    uow.remove(User, beto as never);
    const ghost = uow.add(User, { id: 9, name: "fantasma", visits: 0 });
    uow.remove(User, ghost as never);

    const result = await uow.flush();
    expect(result).toEqual({ inserted: 0, updated: 0, deleted: 1 });
    expect(await users.count()).toBe(1);
    expect(await users.getByIdOrNull(9)).toBeNull();
  });

  it("leaves nothing half-applied when a statement fails", async () => {
    const uow = engine.session().unitOfWork();
    const ana = (await uow.get(User, 1)) as Tracked<{ visits: number }>;
    ana.visits = 99;
    // A second row with the same primary key: the INSERT fails, and the UPDATE
    // that ran before it has to go with it.
    uow.add(User, { id: 2, name: "duplicado", visits: 0 });

    await expect(uow.flush()).rejects.toThrow();
    expect((await users.getById(1)).visits).toBe(1);
    expect(await users.count()).toBe(2);
  });

  it("compares Date by value, so an equal instant is not a change", async () => {
    const seen = new Date("2026-01-01T00:00:00.000Z");
    await users.update({ id: 1 }, { seenAt: seen });

    const uow = engine.session().unitOfWork();
    const user = (await uow.get(User, 1)) as Tracked<{ seenAt: Date | null }>;
    user.seenAt = new Date(seen.getTime());
    expect(await uow.flush()).toEqual({ inserted: 0, updated: 0, deleted: 0 });
  });

  it("tracks a row loaded elsewhere, and keeps identity", async () => {
    const uow = engine.session().unitOfWork();
    const [loaded] = await engine
      .session()
      .execute(select(User).where({ id: 1 }))
      .all();
    const tracked = uow.track(User, loaded as never) as Tracked<{ visits: number }>;
    expect(uow.track(User, loaded as never)).toBe(tracked);

    tracked.visits = 7;
    expect((await uow.flush()).updated).toBe(1);
    expect((await users.getById(1)).visits).toBe(7);
  });

  it("clear() drops everything without writing", async () => {
    const uow = engine.session().unitOfWork();
    const user = (await uow.get(User, 1)) as Tracked<{ visits: number }>;
    user.visits = 1000;
    uow.clear();
    expect(uow.size).toBe(0);
    expect(await uow.flush()).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect((await users.getById(1)).visits).toBe(1);
  });
});
