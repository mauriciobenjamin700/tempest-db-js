import { describe, expectTypeOf, it } from "vitest";
import {
  type AsyncSession,
  type InferModel,
  Model,
  type Tracked,
  column,
} from "../src/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
}

type UserRow = InferModel<typeof User>;

/** A function that only accepts a row the unit of work is watching. */
declare function persistLater(row: Tracked<UserRow>): void;

declare const tracked: Tracked<UserRow>;
declare const session: AsyncSession;

describe("UnitOfWork — types", () => {
  it("keeps the row's own shape", () => {
    expectTypeOf<Tracked<UserRow>["name"]>().toEqualTypeOf<string>();
  });

  it("accepts a tracked row where one is required", () => {
    persistLater(tracked);
  });

  it("returns a tracked row from get()", async () => {
    const row = await session.unitOfWork().get(User, 1);
    expectTypeOf(row).toEqualTypeOf<Tracked<UserRow> | null>();
  });
});
