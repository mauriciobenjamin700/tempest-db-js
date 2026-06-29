import { describe, it } from "vitest";
import { Model, column, select } from "../src/index.js";

class Event extends Model {
  static override tablename = "events";
  id = column.integer().primaryKey();
  name = column.varchar(80).notNull();
  attendees = column.bigInteger().notNull();
  startsAt = column.datetime().notNull();
  published = column.boolean().notNull();
  tags = column.text(); // nullable
  status = column.enum("draft", "live", "done").notNull();
}

describe("Phase 3 — operators valid per column type", () => {
  it("accepts numeric/date ordered operators", () => {
    select(Event).where({ id: { gt: 1, lte: 100 } });
    select(Event).where({ attendees: { gte: 10n, between: [0n, 99n] } });
    select(Event).where({ startsAt: { gt: new Date(), lt: new Date() } });
  });

  it("accepts string operators on string/enum/nullable columns", () => {
    select(Event).where({ name: { like: "%conf%", ilike: "%CONF%" } });
    select(Event).where({ tags: { like: "%music%" } }); // nullable string
    select(Event).where({ status: { in: ["live", "done"] } });
  });

  it("accepts boolean equality and isNull", () => {
    select(Event).where({ published: { eq: true } });
    select(Event).where({ tags: { isNull: true } });
  });

  it("accepts bare-value shorthand (eq)", () => {
    select(Event).where({ id: 1, published: true, status: "live" });
  });
});

describe("Phase 3 — invalid operator/type combos are compile errors", () => {
  it("rejects like on a number", () => {
    // @ts-expect-error - `like` is not valid on a number column
    select(Event).where({ id: { like: "%1%" } });
  });

  it("rejects gt on a string", () => {
    // @ts-expect-error - `gt` is not valid on a string column
    select(Event).where({ name: { gt: "a" } });
  });

  it("rejects between on a boolean", () => {
    // @ts-expect-error - `between` is not valid on a boolean column
    select(Event).where({ published: { between: [false, true] } });
  });

  it("rejects an enum value outside the set in `in`", () => {
    // @ts-expect-error - "cancelled" is not a declared status
    select(Event).where({ status: { in: ["live", "cancelled"] } });
  });

  it("rejects a wrong-typed eq value", () => {
    // @ts-expect-error - id is a number, not a string
    select(Event).where({ id: { eq: "1" } });
  });
});
