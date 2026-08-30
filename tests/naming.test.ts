import { describe, expect, it } from "vitest";
import {
  Model,
  type SyncSession,
  column,
  columnNamesOf,
  createSyncEngine,
  del,
  getDialect,
  insert,
  join,
  select,
  toSnakeCase,
  update,
} from "../src/index.js";
import { reflectTable } from "../src/migrations/index.js";

class ApiKey extends Model {
  static override tablename = "api_keys";
  id = column.integer().primaryKey();
  consumerName = column.text().name("consumer_name").notNull();
  rateLimitBurst = column.integer().name("rate_limit_burst").notNull();
}

class AdminUser extends Model {
  static override tablename = "admin_users";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  userName = column.text().notNull();
  createdAt = column.datetime().notNull();
}

class Plain extends Model {
  static override tablename = "plain";
  id = column.integer().primaryKey();
  name = column.text().notNull();
}

const pg = getDialect("postgresql");

describe("toSnakeCase", () => {
  it("converts camelCase and acronym runs", () => {
    expect(toSnakeCase("consumerName")).toBe("consumer_name");
    expect(toSnakeCase("rateLimitBurst")).toBe("rate_limit_burst");
    expect(toSnakeCase("apiURLBase")).toBe("api_url_base");
    expect(toSnakeCase("id")).toBe("id");
  });
});

describe("column name mapping", () => {
  it("is null for a model that renames nothing", () => {
    expect(columnNamesOf(Plain)).toBeNull();
  });

  it("maps explicit names", () => {
    expect(columnNamesOf(ApiKey)).toEqual({
      id: "id",
      consumerName: "consumer_name",
      rateLimitBurst: "rate_limit_burst",
    });
  });

  it("applies the snake_case strategy to every column", () => {
    expect(columnNamesOf(AdminUser)).toEqual({
      id: "id",
      userName: "user_name",
      createdAt: "created_at",
    });
  });

  it("rejects two properties mapping to the same column", () => {
    class Clash extends Model {
      static override tablename = "clash";
      id = column.integer().primaryKey();
      userName = column.text();
      user_name = column.text();
      static override naming = "snake_case" as const;
    }
    expect(() => columnNamesOf(Clash)).toThrow(/both map to column "user_name"/);
  });
});

describe("the mapping reaches every clause", () => {
  it("select, where, orderBy and projection", () => {
    const q = select(ApiKey, ["consumerName"])
      .where({ consumerName: "x" })
      .orderBy("rateLimitBurst", "desc");
    expect(pg.compile(q.node).sql).toBe(
      'SELECT "consumer_name" FROM "api_keys" WHERE "consumer_name" = $1 ORDER BY "rate_limit_burst" DESC',
    );
  });

  it("insert columns, conflict target and returning", () => {
    const q = insert(ApiKey)
      .values({ id: 1, consumerName: "x", rateLimitBurst: 5 })
      .onConflictDoUpdate(["consumerName"], { rateLimitBurst: 9 })
      .returning(["consumerName"]);
    expect(pg.compile(q.node).sql).toBe(
      'INSERT INTO "api_keys" ("id", "consumer_name", "rate_limit_burst") VALUES ($1, $2, $3) ' +
        'ON CONFLICT ("consumer_name") DO UPDATE SET "rate_limit_burst" = $4 ' +
        'RETURNING "consumer_name"',
    );
  });

  it("update set and delete where", () => {
    const upd = update(ApiKey).set({ rateLimitBurst: 2 }).where({ consumerName: "x" });
    expect(pg.compile(upd.node).sql).toBe(
      'UPDATE "api_keys" SET "rate_limit_burst" = $1 WHERE "consumer_name" = $2',
    );
    const rem = del(ApiKey).where({ consumerName: "x" });
    expect(pg.compile(rem.node).sql).toBe(
      'DELETE FROM "api_keys" WHERE "consumer_name" = $1',
    );
  });

  it("group by and aggregates", () => {
    const q = select(ApiKey).aggregate(["consumerName"], {});
    expect(pg.compile(q.node).sql).toContain('GROUP BY "consumer_name"');
  });

  it("join qualification, while keeping the property-name output alias", () => {
    const q = join(ApiKey, "key")
      .innerJoin(Plain, "plain", { "key.id": "plain.id" })
      .where({ "key.consumerName": "x" });
    const sql = pg.compile(q.node).sql;
    expect(sql).toContain('"key"."consumer_name" AS "key.consumerName"');
    expect(sql).toContain('WHERE "key"."consumer_name" = $1');
  });
});

describe("rows come back in property space", () => {
  function session(): SyncSession {
    const s = createSyncEngine("sqlite://:memory:").session();
    s.raw(
      `CREATE TABLE api_keys (
         id INTEGER PRIMARY KEY,
         consumer_name TEXT NOT NULL,
         rate_limit_burst INTEGER NOT NULL
       )`,
    );
    return s;
  }

  it("round-trips an insert and a select", () => {
    const s = session();
    s.execute(insert(ApiKey).values({ id: 1, consumerName: "acme", rateLimitBurst: 5 }));
    const row = s.execute(select(ApiKey).where({ consumerName: "acme" })).one();
    expect(row).toEqual({ id: 1, consumerName: "acme", rateLimitBurst: 5 });
  });

  it("splits a joined row by property name", () => {
    const s = session();
    s.raw("CREATE TABLE plain (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    s.execute(insert(ApiKey).values({ id: 1, consumerName: "acme", rateLimitBurst: 5 }));
    s.execute(insert(Plain).values({ id: 1, name: "p" }));
    const rows = s
      .execute(join(ApiKey, "key").innerJoin(Plain, "plain", { "key.id": "plain.id" }))
      .all();
    expect(rows[0]?.key).toEqual({ id: 1, consumerName: "acme", rateLimitBurst: 5 });
  });
});

describe("the migration IR speaks database names", () => {
  it("keys columns and the primary key by column name", () => {
    const table = reflectTable(ApiKey);
    expect(Object.keys(table.columns)).toEqual([
      "id",
      "consumer_name",
      "rate_limit_burst",
    ]);
    expect(table.columns.consumer_name?.name).toBe("consumer_name");
  });

  it("maps table-constraint columns too", () => {
    class Composite extends Model {
      static override tablename = "composite";
      static override naming = "snake_case" as const;
      id = column.integer().primaryKey();
      tenantId = column.integer().notNull();
      userName = column.text().notNull();
      static override tableArgs = () => [
        { kind: "unique" as const, columns: ["tenantId", "userName"] },
      ];
    }
    const table = reflectTable(Composite);
    expect(table.uniqueConstraints[0]).toEqual({
      name: "uq_composite_tenant_id_user_name",
      columns: ["tenant_id", "user_name"],
    });
  });
});
