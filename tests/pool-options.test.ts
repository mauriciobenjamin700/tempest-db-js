import { describe, expect, it } from "vitest";
import { Model, column, createEngine, select } from "../src/index.js";

class Row extends Model {
  static override tablename = "rows";
  id = column.integer().primaryKey();
}

describe("pool health options", () => {
  it("refuses prePing and recycleMs on MySQL, where there is no equivalent", async () => {
    const withPrePing = createEngine("mysql://root@localhost/app", {
      pool: { prePing: true },
    });
    await expect(withPrePing.session().execute(select(Row)).all()).rejects.toThrow(
      /PostgreSQL-only; mysql2 has no equivalent/,
    );

    const withRecycle = createEngine("mysql://root@localhost/app", {
      pool: { recycleMs: 1000 },
    });
    await expect(withRecycle.session().execute(select(Row)).all()).rejects.toThrow(
      /PostgreSQL-only/,
    );
  });

  it("ignores the pool block on SQLite", () => {
    const engine = createEngine("sqlite://:memory:", {
      pool: { size: 10, prePing: true, recycleMs: 1000 },
    });
    expect(engine.dialect).toBe("sqlite");
  });
});
