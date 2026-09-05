import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  BaseRepository,
  Model,
  RecordNotFound,
  TenantScopedRepository,
  column,
  createEngine,
} from "../src/index.js";

class Doc extends Model {
  static override tablename = "docs";
  id = column.integer().primaryKey();
  tenantId = column.integer().notNull();
  title = column.varchar(40).notNull();
}

class Global extends Model {
  static override tablename = "globals";
  id = column.integer().primaryKey();
}

const DDL = [
  "CREATE TABLE docs (id INTEGER PRIMARY KEY, tenantId INTEGER NOT NULL, title TEXT NOT NULL)",
  "CREATE TABLE globals (id INTEGER PRIMARY KEY)",
];

describe("TenantScopedRepository", () => {
  let engine: AsyncEngine;
  let tenantOne: TenantScopedRepository<typeof Doc>;
  let tenantTwo: TenantScopedRepository<typeof Doc>;
  let unscoped: BaseRepository<typeof Doc>;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:");
    for (const stmt of DDL) {
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(stmt, []);
    }
    const session = engine.session();
    tenantOne = new TenantScopedRepository(Doc, session, { column: "tenantId", id: 1 });
    tenantTwo = new TenantScopedRepository(Doc, session, { column: "tenantId", id: 2 });
    unscoped = new BaseRepository(Doc, session);
    await unscoped.createMany([
      { id: 1, tenantId: 1, title: "um" },
      { id: 2, tenantId: 2, title: "dois" },
      { id: 3, tenantId: 2, title: "tres" },
    ]);
  });

  it("confines every read to its tenant", async () => {
    expect((await tenantOne.list()).map((d) => d.id)).toEqual([1]);
    expect((await tenantTwo.list()).map((d) => d.id)).toEqual([2, 3]);
    expect(await tenantOne.count()).toBe(1);
    expect(await tenantTwo.count()).toBe(2);
    expect(await tenantOne.exists({ title: "dois" })).toBe(false);
    expect(await tenantOne.first({ title: "dois" })).toBeNull();
  });

  it("treats another tenant's row as not found", async () => {
    expect(await tenantOne.getByIdOrNull(2)).toBeNull();
    await expect(tenantOne.getById(2)).rejects.toThrow(RecordNotFound);
    expect((await tenantTwo.getById(2)).title).toBe("dois");
  });

  it("scopes paginate and cursorPaginate", async () => {
    const page = await tenantTwo.paginate({ pageSize: 10 });
    expect(page.total).toBe(2);
    expect(page.items.map((d) => d.id)).toEqual([2, 3]);

    const cursor = await tenantOne.cursorPaginate({ limit: 10 });
    expect(cursor.items.map((d) => d.id)).toEqual([1]);
  });

  it("stamps the tenant on writes", async () => {
    const created = await tenantOne.create({ id: 4, title: "quatro" } as never);
    expect(created.tenantId).toBe(1);
    expect(await tenantTwo.getByIdOrNull(4)).toBeNull();
  });

  it("refuses a write naming another tenant instead of rewriting it", async () => {
    await expect(
      tenantOne.create({ id: 5, tenantId: 2, title: "invasor" }),
    ).rejects.toThrow(/Refusing to write docs.tenantId = 2/);
    expect(await unscoped.count()).toBe(3);
  });

  it("cannot update or delete across tenants", async () => {
    expect(await tenantOne.update({ id: 2 }, { title: "hackeado" })).toBe(0);
    expect((await unscoped.getById(2)).title).toBe("dois");

    expect(await tenantOne.delete({})).toBe(1);
    expect(await unscoped.count()).toBe(2);
  });

  it("refuses a model without the tenant column", () => {
    expect(
      () =>
        new TenantScopedRepository(Global, engine.session(), {
          column: "tenantId",
          id: 1,
        }),
    ).toThrow(/has no "tenantId" column/);
  });
});
