import { describe, expect, it } from "vitest";
import {
  Model,
  type SyncSession,
  column,
  createSyncEngine,
  getDialect,
  insert,
  select,
} from "../src/index.js";

class AdminUser extends Model {
  static override tablename = "admin_users";
  id = column.integer().primaryKey();
  username = column.text().notNull();
}

const pg = getDialect("postgresql");
const sqlite = getDialect("sqlite");
const mysql = getDialect("mysql");

function session(): SyncSession {
  const s = createSyncEngine("sqlite://:memory:").session();
  s.raw("CREATE TABLE admin_users (id INTEGER PRIMARY KEY, username TEXT NOT NULL)");
  s.execute(insert(AdminUser).values({ id: 1, username: "MixedCase" }));
  s.execute(insert(AdminUser).values({ id: 2, username: "other" }));
  return s;
}

describe("ieq — case-insensitive equality", () => {
  it("compiles to lower() on both sides, portably", () => {
    const q = select(AdminUser).where({ username: { ieq: "MIXEDCASE" } });
    expect(pg.compile(q.node)).toEqual({
      sql: 'SELECT * FROM "admin_users" WHERE lower("username") = lower($1)',
      params: ["MIXEDCASE"],
    });
    expect(sqlite.compile(q.node).sql).toContain('lower("username") = lower(?)');
    expect(mysql.compile(q.node).sql).toContain("lower(`username`) = lower(?)");
  });

  it("has no wildcards — the trap ilike carries", () => {
    const s = session();
    expect(
      s.execute(select(AdminUser).where({ username: { ieq: "mixedcase" } })).all(),
    ).toHaveLength(1);
    expect(s.execute(select(AdminUser).where({ username: { ieq: "%" } })).all()).toEqual(
      [],
    );
  });

  it("matches regardless of case", () => {
    const s = session();
    for (const probe of ["MixedCase", "mixedcase", "MIXEDCASE"]) {
      expect(
        s.execute(select(AdminUser).where({ username: { ieq: probe } })).one().id,
      ).toBe(1);
    }
  });

  it("degrades to IS NULL for a null operand", () => {
    const q = select(AdminUser).where({ username: { ieq: null as never } });
    expect(pg.compile(q.node).sql).toContain('"username" IS NULL');
  });

  it("documents the contrast: ilike is a pattern and matches everything on %", () => {
    const s = session();
    expect(
      s.execute(select(AdminUser).where({ username: { ilike: "%" } })).all(),
    ).toHaveLength(2);
  });
});
