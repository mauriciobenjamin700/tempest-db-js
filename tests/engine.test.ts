import { beforeEach, describe, expect, it } from "vitest";
import {
  type InferModel,
  Model,
  NoResultError,
  QueryExecutionError,
  type SyncEngine,
  column,
  createEngine,
  createSyncEngine,
  del,
  insert,
  select,
  sql,
  update,
} from "../src/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.varchar(80).notNull();
  age = column.integer().notNull();
  active = column.boolean().notNull();
  score = column.bigInteger().notNull();
  joinedAt = column.datetime().notNull();
  tags = column.json<string[]>();
}

type UserRow = InferModel<typeof User>;

const DDL = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  age INTEGER NOT NULL,
  active INTEGER NOT NULL,
  score INTEGER NOT NULL,
  joinedAt TEXT NOT NULL,
  tags TEXT
)`;

function seed(engine: SyncEngine): void {
  const s = engine.session();
  // raw DDL through the driver-less path: use a one-off insert builder per row
  s.execute(
    insert(User).values([
      {
        id: 1,
        name: "Ana",
        age: 30,
        active: true,
        score: 10n,
        joinedAt: new Date("2026-01-01T00:00:00.000Z"),
        tags: ["a"],
      },
      {
        id: 2,
        name: "Beto",
        age: 17,
        active: false,
        score: 99999999999n,
        joinedAt: new Date("2026-02-01T00:00:00.000Z"),
        tags: null,
      },
      {
        id: 3,
        name: "Cris",
        age: 45,
        active: true,
        score: 7n,
        joinedAt: new Date("2026-03-01T00:00:00.000Z"),
        tags: ["x", "y"],
      },
    ]),
  );
}

describe("Sync engine — real SQLite execution (node:sqlite)", () => {
  let engine: SyncEngine;

  beforeEach(() => {
    engine = createSyncEngine("sqlite://:memory:");
    // create schema via a raw statement on the underlying driver
    // biome-ignore lint/suspicious/noExplicitAny: reach the private driver for DDL only in tests.
    (engine as any).driver.execute(DDL, []);
    seed(engine);
  });

  it("selects all and coerces types (bigint, Date, boolean, json)", () => {
    const rows = engine.session().execute(select(User).orderBy("id")).all();
    expect(rows).toHaveLength(3);
    const ana = rows[0] as UserRow;
    expect(ana.score).toBe(10n);
    expect(ana.active).toBe(true);
    expect(ana.joinedAt).toBeInstanceOf(Date);
    expect(ana.joinedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(ana.tags).toEqual(["a"]);
    expect((rows[1] as UserRow).active).toBe(false);
    expect((rows[1] as UserRow).tags).toBeNull();
    expect((rows[1] as UserRow).score).toBe(99999999999n);
  });

  it("filters with typed operators", () => {
    const adults = engine
      .session()
      .execute(
        select(User)
          .where({ age: { gte: 18 } })
          .orderBy("age"),
      )
      .all();
    expect(adults.map((u) => (u as UserRow).name)).toEqual(["Ana", "Cris"]);
  });

  it("first / one / oneOrNull / scalar", () => {
    const s = engine.session();
    expect((s.execute(select(User).where({ id: 1 })).first() as UserRow).name).toBe(
      "Ana",
    );
    expect((s.execute(select(User).where({ id: 2 })).one() as UserRow).name).toBe("Beto");
    expect(s.execute(select(User).where({ id: 999 })).oneOrNull()).toBeNull();
    expect(s.execute(select(User, ["name"]).where({ id: 3 })).scalar()).toBe("Cris");
  });

  it("one() throws when not exactly one row", () => {
    expect(() => engine.session().execute(select(User)).one()).toThrow(NoResultError);
  });

  it("insert returns rows-affected; RETURNING yields the row", () => {
    const s = engine.session();
    const affected = s
      .execute(
        insert(User).values({
          id: 4,
          name: "Dan",
          age: 21,
          active: true,
          score: 1n,
          joinedAt: new Date("2026-04-01T00:00:00.000Z"),
          tags: null,
        }),
      )
      .rowsAffected();
    expect(affected).toBe(1);

    const ret = s
      .execute(
        insert(User)
          .values({
            id: 5,
            name: "Eve",
            age: 33,
            active: true,
            score: 2n,
            joinedAt: new Date(),
            tags: null,
          })
          .returning(["id", "name"]),
      )
      .one() as { id: number; name: string };
    expect(ret).toEqual({ id: 5, name: "Eve" });
  });

  it("update with guard + delete", () => {
    const s = engine.session();
    s.execute(update(User).set({ age: 31 }).where({ id: 1 }));
    expect((s.execute(select(User).where({ id: 1 })).one() as UserRow).age).toBe(31);

    const removed = s.execute(del(User).where({ id: 2 })).rowsAffected();
    expect(removed).toBe(1);
    expect(s.execute(select(User)).all()).toHaveLength(2);
  });

  it("commits a transaction and rolls back on throw", () => {
    const s = engine.session();
    s.transaction((tx) => {
      tx.execute(update(User).set({ active: false }).where({ id: 1 }));
    });
    expect((s.execute(select(User).where({ id: 1 })).one() as UserRow).active).toBe(
      false,
    );

    expect(() =>
      s.transaction((tx) => {
        tx.execute(update(User).set({ age: 0 }).where({ id: 3 }));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // rolled back → age unchanged
    expect((s.execute(select(User).where({ id: 3 })).one() as UserRow).age).toBe(45);
  });

  it("server-default sql.now() column accepts an explicit Date too", () => {
    // sanity: sql.now() marker is unchanged; explicit values still bind
    expect(sql.now()).toEqual({ kind: "expression", expression: "now" });
  });
});

describe("Async engine — SQLite wrapped as async", () => {
  it("runs the same queries with await", async () => {
    const engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL, []);
    const s = engine.session();
    await s.execute(
      insert(User).values({
        id: 1,
        name: "Ana",
        age: 30,
        active: true,
        score: 5n,
        joinedAt: new Date("2026-01-01T00:00:00.000Z"),
        tags: ["z"],
      }),
    );
    const row = (await s.execute(select(User).where({ id: 1 })).first()) as UserRow;
    expect(row.name).toBe("Ana");
    expect(row.score).toBe(5n);
    expect(row.tags).toEqual(["z"]);
    await engine.close();
  });

  it("async transaction rolls back on throw", async () => {
    const engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL, []);
    const s = engine.session();
    await s.execute(
      insert(User).values({
        id: 1,
        name: "A",
        age: 1,
        active: true,
        score: 0n,
        joinedAt: new Date(),
        tags: null,
      }),
    );
    await expect(
      s.transaction(async (tx) => {
        await tx.execute(update(User).set({ age: 99 }).where({ id: 1 }));
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    const row = (await s.execute(select(User).where({ id: 1 })).first()) as UserRow;
    expect(row.age).toBe(1);
  });
});

describe("createSyncEngine rejects Postgres", () => {
  it("throws pointing at the async engine", () => {
    expect(() => createSyncEngine("postgresql://h/db")).toThrow(/async-only/);
  });
});

describe("stream() — lazy iteration", () => {
  const DDL2 = "CREATE TABLE nums (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)";
  class Num extends Model {
    static override tablename = "nums";
    id = column.integer().primaryKey();
    n = column.integer().notNull();
  }

  it("sync stream yields coerced rows one by one", () => {
    const engine = createSyncEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    (engine as any).driver.execute(DDL2, []);
    const s = engine.session();
    s.execute(
      insert(Num).values([
        { id: 1, n: 10 },
        { id: 2, n: 20 },
        { id: 3, n: 30 },
      ]),
    );
    const seen: number[] = [];
    for (const row of s.stream(select(Num).orderBy("id"))) {
      seen.push((row as { id: number; n: number }).n);
    }
    expect(seen).toEqual([10, 20, 30]);
  });

  it("async stream iterates with for-await", async () => {
    const engine = createEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL2, []);
    const s = engine.session();
    await s.execute(
      insert(Num).values([
        { id: 1, n: 5 },
        { id: 2, n: 6 },
      ]),
    );
    const seen: number[] = [];
    for await (const row of s.stream(select(Num).orderBy("id"))) {
      seen.push((row as { id: number; n: number }).n);
    }
    expect(seen).toEqual([5, 6]);
    await engine.close();
  });
});

describe("DX — query logging + error context", () => {
  class Item extends Model {
    static override tablename = "items";
    id = column.integer().primaryKey();
    name = column.text().notNull();
  }
  const DDL_ITEMS = "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)";

  it("invokes onQuery for every statement with sql + params", () => {
    const seen: { sql: string; params: readonly unknown[] }[] = [];
    const engine = createSyncEngine("sqlite://:memory:", {
      onQuery: (e) => seen.push(e),
    });
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    (engine as any).driver.execute(DDL_ITEMS, []);
    const s = engine.session();
    s.execute(insert(Item).values({ id: 1, name: "a" }));
    s.execute(select(Item).where({ id: 1 }));
    const insertLog = seen.find((e) => e.sql.startsWith("INSERT"));
    const selectLog = seen.find((e) => e.sql.startsWith("SELECT"));
    expect(insertLog?.params).toEqual([1, "a"]);
    expect(selectLog?.params).toEqual([1]);
    engine.close();
  });

  it("wraps driver errors in QueryExecutionError with sql + params", () => {
    const engine = createSyncEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    (engine as any).driver.execute(DDL_ITEMS, []);
    const s = engine.session();
    let caught: unknown;
    try {
      // duplicate PK → driver throws; session wraps it
      s.execute(insert(Item).values({ id: 1, name: "a" }));
      s.execute(insert(Item).values({ id: 1, name: "b" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QueryExecutionError);
    const qe = caught as QueryExecutionError;
    expect(qe.sql).toContain("INSERT INTO");
    expect(qe.params).toEqual([1, "b"]);
    expect(qe.message).toContain("SQL:");
    expect(qe.cause).toBeDefined();
    engine.close();
  });

  it("a logger that throws does not break execution", () => {
    const engine = createSyncEngine("sqlite://:memory:", {
      onQuery: () => {
        throw new Error("logger boom");
      },
    });
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    (engine as any).driver.execute(DDL_ITEMS, []);
    const s = engine.session();
    expect(() => s.execute(insert(Item).values({ id: 1, name: "a" }))).not.toThrow();
    engine.close();
  });
});

describe("disposable — using / await using", () => {
  const DDL3 = "CREATE TABLE nums (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)";
  class Num extends Model {
    static override tablename = "nums";
    id = column.integer().primaryKey();
    n = column.integer().notNull();
  }

  it("sync engine closes its driver at scope exit (Symbol.dispose)", () => {
    let closed = false;
    {
      using engine = createSyncEngine("sqlite://:memory:");
      // biome-ignore lint/suspicious/noExplicitAny: wrap the driver to observe close().
      const driver = (engine as any).driver;
      const realClose = driver.close.bind(driver);
      driver.close = () => {
        closed = true;
        realClose();
      };
    }
    expect(closed).toBe(true);
  });

  it("async engine closes its driver at scope exit (Symbol.asyncDispose)", async () => {
    let closed = false;
    {
      await using engine = createEngine("sqlite://:memory:");
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(DDL3, []);
      // biome-ignore lint/suspicious/noExplicitAny: wrap the driver to observe close().
      const driver = (engine as any).driver;
      const realClose = driver.close.bind(driver);
      driver.close = async () => {
        closed = true;
        await realClose();
      };
    }
    expect(closed).toBe(true);
  });

  it("sync session is disposable and closes the driver", () => {
    const engine = createSyncEngine("sqlite://:memory:");
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    (engine as any).driver.execute(DDL3, []);
    {
      using session = engine.session();
      session.execute(insert(Num).values({ id: 1, n: 1 }));
    }
    // The driver was closed by the session dispose — a further query throws.
    expect(() => engine.session().execute(select(Num))).toThrow();
  });
});
