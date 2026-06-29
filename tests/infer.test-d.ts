import { describe, expectTypeOf, it } from "vitest";
import { type InferInsert, type InferModel, Model, column } from "../src/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  age = column.integer().notNull();
  nickname = column.text(); // nullable — no notNull
  createdAt = column.timestamp().default(new Date(0));
}

type UserRow = InferModel<typeof User>;
type UserInsert = InferInsert<typeof User>;

describe("Phase 1 type inference spike", () => {
  it("infers the SELECT row shape with correct nullability", () => {
    expectTypeOf<UserRow>().toEqualTypeOf<{
      id: number;
      name: string;
      age: number;
      nickname: string | null;
      createdAt: Date | null;
    }>();
  });

  it("infers the INSERT shape: defaulted/PK columns optional, rest required", () => {
    expectTypeOf<UserInsert>().toEqualTypeOf<{
      id?: number;
      createdAt?: Date | null;
      name: string;
      age: number;
      nickname: string | null;
    }>();
  });
});
