import { describe, expect, it } from "vitest";
import {
  Model,
  type SyncEngine,
  column,
  createSyncEngine,
  getDialect,
  insert,
} from "../src/index.js";

class Row extends Model {
  static override tablename = "rows";
  id = column.integer().primaryKey();
}

describe("beginStatements per dialect", () => {
  it("puts everything on BEGIN for PostgreSQL", () => {
    expect(
      getDialect("postgresql").beginStatements({
        isolation: "serializable",
        readOnly: true,
      }),
    ).toEqual(["BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY"]);
    expect(getDialect("postgresql").beginStatements()).toEqual(["BEGIN"]);
  });

  it("sets the level before the block on MySQL", () => {
    expect(getDialect("mysql").beginStatements({ isolation: "repeatable read" })).toEqual(
      ["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", "BEGIN"],
    );
    expect(getDialect("mysql").beginStatements({ readOnly: true })).toEqual([
      "START TRANSACTION READ ONLY",
    ]);
  });

  it("accepts serializable on SQLite and refuses the rest", () => {
    expect(getDialect("sqlite").beginStatements({ isolation: "serializable" })).toEqual([
      "BEGIN",
    ]);
    expect(() =>
      getDialect("sqlite").beginStatements({ isolation: "repeatable read" }),
    ).toThrow(/only implements the "serializable" isolation level/);
    expect(() => getDialect("sqlite").beginStatements({ readOnly: true })).toThrow(
      /no read-only transaction/,
    );
  });
});

describe("transaction characteristics", () => {
  const DDL = "CREATE TABLE rows (id INTEGER PRIMARY KEY)";

  function engineWith(): { engine: SyncEngine; statements: string[] } {
    const statements: string[] = [];
    const engine = createSyncEngine("sqlite://:memory:", {
      onQuery: ({ sql }) => statements.push(sql),
    });
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    (engine as any).driver.execute(DDL, []);
    statements.length = 0;
    return { engine, statements };
  }

  it("emits the dialect's begin statements", () => {
    const { engine, statements } = engineWith();
    engine.transaction(
      (tx) => {
        tx.execute(insert(Row).values({ id: 1 }));
      },
      { isolation: "serializable" },
    );
    expect(statements[0]).toBe("BEGIN");
    expect(statements).toContain("COMMIT");
  });

  it("refuses a level SQLite does not implement, before touching the database", () => {
    const { engine, statements } = engineWith();
    expect(() =>
      engine.transaction(() => undefined, { isolation: "read committed" }),
    ).toThrow(/only implements the "serializable"/);
    expect(statements).toEqual([]);
  });

  it("refuses characteristics on a nested block instead of ignoring them", () => {
    const { engine } = engineWith();
    expect(() =>
      engine.transaction((tx) => {
        tx.transaction(() => undefined, { isolation: "serializable" });
      }),
    ).toThrow(/only be set on the outermost transaction/);
  });
});
