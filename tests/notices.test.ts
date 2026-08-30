/**
 * Driver-option passthrough on SQLite.
 *
 * `onNotice` is only observable against a live PostgreSQL, which is what emits
 * the notices, so it is covered in `postgres-notice.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Model, column, createSyncEngine, insert } from "../src/index.js";

class Thing extends Model {
  static override tablename = "things";
  id = column.integer().primaryKey();
  name = column.text().notNull();
}

describe("driver options passthrough (SQLite)", () => {
  it("forwards driverOptions to node:sqlite", () => {
    const engine = createSyncEngine("sqlite://:memory:", {
      driverOptions: { readOnly: false },
    });
    const session = engine.session();
    session.raw("CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    session.execute(insert(Thing).values({ id: 1, name: "ok" }));
    expect(session.raw("SELECT count(*) AS n FROM things").scalar()).toBe(1);
    engine.close();
  });

  it("surfaces a rejected driver option instead of swallowing it", () => {
    expect(() =>
      createSyncEngine("sqlite://:memory:", {
        driverOptions: { readOnly: true },
      })
        .session()
        .raw("CREATE TABLE t (id INTEGER)"),
    ).toThrow();
  });
});
