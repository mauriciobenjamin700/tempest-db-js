import { describe, expectTypeOf, it } from "vitest";
import { Model, column } from "../src/index.js";
import { type SelectBuilder, select } from "../src/query.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  age = column.integer().notNull();
  nickname = column.text();
}

/** Extract the result element type a builder will yield. */
type RowOf<B> = B extends SelectBuilder<infer _F, infer P> ? P : never;

describe("Phase 2 query builder spike", () => {
  it("infers the full row type for an unprojected select", () => {
    const q = select(User);
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{
      id: number;
      name: string;
      age: number;
      nickname: string | null;
    }>();
  });

  it("infers a Pick projection when columns are listed", () => {
    const q = select(User, ["id", "name"]);
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{
      id: number;
      name: string;
    }>();
  });

  it("preserves the projection through chained clauses", () => {
    const q = select(User, ["id", "age"])
      .where({ age: { gt: 18 } })
      .orderBy("age", "desc")
      .limit(10);
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{ id: number; age: number }>();
  });

  it("rejects where-keys that are not columns", () => {
    // @ts-expect-error - `unknownColumn` is not a column of User
    select(User).where({ unknownColumn: 1 });
  });

  it("rejects orderBy on a non-column", () => {
    // @ts-expect-error - `bogus` is not a column of User
    select(User).orderBy("bogus");
  });

  it("rejects projecting a non-existent column", () => {
    // @ts-expect-error - `missing` is not a column of User
    select(User, ["id", "missing"]);
  });
});
