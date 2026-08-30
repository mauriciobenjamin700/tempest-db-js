/**
 * MySQL integration tests — real execution against a live database.
 *
 * Gated on `TEST_MYSQL_URL`: skipped entirely when it is not set, so the default
 * `npm test` (SQLite-only) stays green without a MySQL. CI sets it to a service
 * container; locally, point it at any throwaway MySQL, e.g.:
 *
 *   docker run -d -e MYSQL_ROOT_PASSWORD=test -e MYSQL_DATABASE=tdbjs -p 3307:3306 mysql:8
 *   TEST_MYSQL_URL=mysql://root:test@localhost:3307/tdbjs npm test
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AsyncDriver,
  type AsyncEngine,
  BaseRepository,
  Model,
  activeRecord,
  col,
  column,
  createEngine,
  del,
  fn,
  insert,
  select,
  sql,
  update,
} from "../src/index.js";
import { reflectTable, renderOperation } from "../src/migrations/index.js";

const url = process.env.TEST_MYSQL_URL;

class Task extends Model {
  static override tablename = "tasks";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  ownerName = column.varchar(80).notNull();
  title = column.varchar(120).notNull();
  attempts = column.integer().notNull().default(0);
  done = column.boolean().notNull().default(false);
}

class Note extends Model {
  static override tablename = "notes";
  id = column.uuid().primaryKey();
  body = column.text().notNull();
}

describe.skipIf(!url)("MySQL — real execution", () => {
  let engine: AsyncEngine;
  let driver: AsyncDriver;

  beforeAll(async () => {
    engine = createEngine(url as string);
    driver = (engine as unknown as { driver: AsyncDriver }).driver;
    for (const table of ["tasks", "notes"]) {
      await driver.execute(`DROP TABLE IF EXISTS \`${table}\``, []);
    }
    for (const model of [Task, Note]) {
      for (const stmt of renderOperation(
        { kind: "create_table", table: reflectTable(model) },
        "mysql",
      )) {
        await driver.execute(stmt, []);
      }
    }
  });

  afterAll(async () => {
    for (const table of ["tasks", "notes"]) {
      await driver.execute(`DROP TABLE IF EXISTS \`${table}\``, []);
    }
    await engine.close();
  });

  it("creates the snake_case schema and round-trips a plain insert", async () => {
    const session = engine.session();
    const affected = await session
      .execute(
        insert(Task).values({
          ownerName: "Ana",
          title: "ship",
          attempts: 0,
          done: false,
        }),
      )
      .rowsAffected();
    expect(affected).toBe(1);
    const rows = await session.execute(select(Task).where({ ownerName: "Ana" })).all();
    expect(rows[0]?.title).toBe("ship");
    expect(rows[0]?.done).toBe(false);
  });

  it("honors .returning() on a single-row insert via LAST_INSERT_ID", async () => {
    const session = engine.session();
    const row = await session
      .execute(
        insert(Task)
          .values({ ownerName: "Beto", title: "read back", attempts: 0, done: false })
          .returning(),
      )
      .one();
    expect(row.title).toBe("read back");
    expect(row.ownerName).toBe("Beto");
    expect(typeof row.id).toBe("number");
    expect(row.id).toBeGreaterThan(0);
  });

  it("reads back by a client-supplied primary key too", async () => {
    const session = engine.session();
    const row = await session
      .execute(
        insert(Note)
          .values({ id: "11111111-1111-1111-1111-111111111111", body: "hello" })
          .returning(["body"]),
      )
      .one();
    expect(row).toEqual({ body: "hello" });
  });

  it("refuses to read back a multi-row insert", async () => {
    const session = engine.session();
    await expect(
      session
        .execute(
          insert(Task)
            .values([
              { ownerName: "x", title: "a", attempts: 0, done: false },
              { ownerName: "x", title: "b", attempts: 0, done: false },
            ])
            .returning(),
        )
        .all(),
    ).rejects.toThrow(/multi-row insert is not reliable/);
  });

  it("keeps the read-back on one connection inside a transaction", async () => {
    const created = await engine.transaction(async (tx) => {
      return tx
        .execute(
          insert(Task)
            .values({ ownerName: "Carla", title: "in tx", attempts: 0, done: false })
            .returning(),
        )
        .one();
    });
    expect(created.title).toBe("in tx");
  });

  it("rolls the read-back insert back with its transaction", async () => {
    const session = engine.session();
    await expect(
      engine.transaction(async (tx) => {
        await tx
          .execute(
            insert(Task)
              .values({ ownerName: "ghost", title: "gone", attempts: 0, done: false })
              .returning(),
          )
          .one();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(
      await session.execute(select(Task).where({ ownerName: "ghost" })).all(),
    ).toEqual([]);
  });

  it("makes BaseRepository.create work", async () => {
    const repo = new BaseRepository(Task, engine.session());
    const created = await repo.create({
      ownerName: "Dora",
      title: "via repo",
      attempts: 0,
      done: false,
    });
    expect(created.title).toBe("via repo");
    expect(await repo.getById(created.id)).toMatchObject({ ownerName: "Dora" });
  });

  it("makes activeRecord.save work", async () => {
    const session = engine.session();
    const record = activeRecord(Note, session).create({
      id: "22222222-2222-2222-2222-222222222222",
      body: "draft",
    });
    await record.save();
    record.data.body = "final";
    await record.save();
    const rows = await session
      .execute(select(Note).where({ id: "22222222-2222-2222-2222-222222222222" }))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("final");
  });

  it("upserts through ON DUPLICATE KEY UPDATE", async () => {
    const session = engine.session();
    await session
      .execute(
        insert(Note).values({ id: "33333333-3333-3333-3333-333333333333", body: "one" }),
      )
      .rowsAffected();
    await session
      .execute(
        insert(Note)
          .values({ id: "33333333-3333-3333-3333-333333333333", body: "two" })
          .onConflictDoUpdate(["id"], { body: "two" }),
      )
      .rowsAffected();
    const row = await session
      .execute(select(Note).where({ id: "33333333-3333-3333-3333-333333333333" }))
      .one();
    expect(row.body).toBe("two");
  });

  it("increments atomically with a SQL expression", async () => {
    const session = engine.session();
    const created = await session
      .execute(
        insert(Task)
          .values({ ownerName: "counter", title: "c", attempts: 0, done: false })
          .returning(),
      )
      .one();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        session
          .execute(
            update(Task)
              .set({ attempts: sql.raw("attempts + 1") })
              .where({ id: created.id }),
          )
          .rowsAffected(),
      ),
    );
    const row = await session.execute(select(Task).where({ id: created.id })).one();
    expect(row.attempts).toBe(4);
  });

  it("claims disjoint batches with FOR UPDATE SKIP LOCKED", async () => {
    const session = engine.session();
    await session.raw("DELETE FROM `tasks`").rowsAffected();
    for (let i = 0; i < 6; i++) {
      await session
        .execute(
          insert(Task).values({
            ownerName: "queue",
            title: `t${i}`,
            attempts: 0,
            done: false,
          }),
        )
        .rowsAffected();
    }
    const claim = async (): Promise<number[]> =>
      engine.transaction(async (tx) => {
        const rows = await tx
          .execute(
            select(Task, ["id"])
              .where({ ownerName: "queue", done: false })
              .orderBy("id")
              .limit(3)
              .forUpdate({ skipLocked: true }),
          )
          .all();
        const ids = rows.map((r) => r.id);
        if (ids.length > 0) {
          await tx
            .execute(
              update(Task)
                .set({ done: true })
                .where({ id: { in: ids } }),
            )
            .rowsAffected();
        }
        return ids;
      });
    const [first, second] = await Promise.all([claim(), claim()]);
    expect(first.filter((id) => second.includes(id))).toEqual([]);
    expect([...first, ...second]).toHaveLength(6);
  });

  it("filters with a subquery, an expression and ieq", async () => {
    const session = engine.session();
    const withSubquery = await session
      .execute(
        select(Task).where({
          id: { in: select(Task).where({ ownerName: "queue" }).asSubquery("id") },
        }),
      )
      .all();
    expect(withSubquery).toHaveLength(6);

    expect(() =>
      session.execute(
        select(Task).where({
          id: { in: select(Task).limit(2).asSubquery("id") },
        }),
      ),
    ).toThrow(/does not support LIMIT\/OFFSET inside an IN subquery/);

    const insensitive = await session
      .execute(select(Task).where({ ownerName: { ieq: "QUEUE" } }))
      .all();
    expect(insensitive).toHaveLength(6);

    const byFunction = await session
      .execute(select(Task).where(fn.lower("ownerName").eq(fn.lower(col("owner_name")))))
      .all();
    expect(byFunction.length).toBeGreaterThan(0);
  });

  it("groups with HAVING", async () => {
    const session = engine.session();
    const rows = await session
      .execute(
        select(Task)
          .aggregate(["ownerName"], { n: (await import("../src/index.js")).count() })
          .having({ n: { gte: 6 } }),
      )
      .all();
    expect(rows).toEqual([{ ownerName: "queue", n: 6 }]);
  });

  it("deletes behind the guard", async () => {
    const session = engine.session();
    const removed = await session
      .execute(del(Task).where({ ownerName: "queue" }))
      .rowsAffected();
    expect(removed).toBe(6);
  });
});
