import { describe, expect, it } from "vitest";
import { Model, column, getDialect, insert, select, sql } from "../src/index.js";
import { renderOperation } from "../src/migrations/index.js";
import { reflectTable } from "../src/migrations/index.js";

class ApiKey extends Model {
  static override tablename = "api_keys";
  id = column.integer().primaryKey();
  scopes = column.array(column.text()).notNull().default(["send"]);
  quotas = column.array(column.integer());
}

const pg = getDialect("postgresql");
const sqlite = getDialect("sqlite");

const createTable = {
  kind: "create_table" as const,
  table: reflectTable(ApiKey),
};

describe("column.array", () => {
  it("carries the element type in the IR", () => {
    const table = reflectTable(ApiKey);
    expect(table.columns.scopes?.type).toEqual({
      kind: "array",
      meta: { element: { kind: "text", meta: {} } },
    });
  });

  it("renders text[] and integer[] with an ARRAY default on PostgreSQL", () => {
    const [ddl] = renderOperation(createTable, "postgresql");
    expect(ddl).toContain(`"scopes" TEXT[] NOT NULL DEFAULT ARRAY['send']::TEXT[]`);
    expect(ddl).toContain('"quotas" INTEGER[]');
  });

  it("throws rather than silently falling back on SQLite and MySQL", () => {
    expect(() => renderOperation(createTable, "sqlite")).toThrow(/PostgreSQL-only/);
    expect(() => renderOperation(createTable, "mysql")).toThrow(/PostgreSQL-only/);
  });

  it("accepts an array value on insert", () => {
    const q = insert(ApiKey).values({ id: 1, scopes: ["send", "read"], quotas: null });
    expect(pg.compile(q.node).params).toEqual([1, ["send", "read"], null]);
  });

  it("still rejects an array on a scalar column", () => {
    expect(() =>
      insert(ApiKey).values({ id: [1], scopes: [], quotas: null } as never),
    ).toThrow(/cannot be bound/);
  });

  it("keeps a literal default renderable through sql.raw", () => {
    const col = column.array(column.text()).default(sql.raw("'{}'::text[]"));
    expect(col.defaultValue).toMatchObject({ kind: "expression" });
  });
});

describe("array operators", () => {
  it("compiles @>, <@ and && on PostgreSQL", () => {
    expect(
      pg.compile(select(ApiKey).where({ scopes: { contains: ["send"] } }).node),
    ).toEqual({
      sql: 'SELECT * FROM "api_keys" WHERE "scopes" @> $1',
      params: [["send"]],
    });
    expect(
      pg.compile(select(ApiKey).where({ scopes: { containedBy: ["send"] } }).node).sql,
    ).toContain('"scopes" <@ $1');
    expect(
      pg.compile(select(ApiKey).where({ scopes: { overlaps: ["send"] } }).node).sql,
    ).toContain('"scopes" && $1');
  });

  it("throws on a dialect without native arrays", () => {
    const q = select(ApiKey).where({ scopes: { contains: ["send"] } });
    expect(() => sqlite.compile(q.node)).toThrow(/needs native array support/);
  });
});
