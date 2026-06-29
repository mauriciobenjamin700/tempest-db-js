import { describe, expectTypeOf, it } from "vitest";
import {
  type DeleteBuilder,
  type InsertBuilder,
  Model,
  type UpdateBuilder,
  column,
  del,
  insert,
  update,
} from "../src/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  age = column.integer().notNull();
  nickname = column.text();
}

/** Extract the execution-result type a mutation builder yields. */
type RowOf<B> = B extends InsertBuilder<infer _F, infer _I, infer R>
  ? R
  : B extends UpdateBuilder<infer _F2, infer _G, infer R2>
    ? R2
    : B extends DeleteBuilder<infer _F3, infer _G3, infer R3>
      ? R3
      : never;

/** Extract the guarded flag of an update/delete builder. */
type GuardOf<B> = B extends UpdateBuilder<infer _F, infer G, infer _R>
  ? G
  : B extends DeleteBuilder<infer _F2, infer G2, infer _R2>
    ? G2
    : never;

describe("Phase 2 INSERT", () => {
  it("accepts the insert shape (defaults/PK optional)", () => {
    insert(User).values({ name: "Ben", age: 30, nickname: null });
    insert(User).values({ id: 1, name: "Ben", age: 30, nickname: "b" });
    insert(User).values([{ name: "A", age: 1, nickname: null }]);
  });

  it("rejects missing required columns", () => {
    // @ts-expect-error - `age` is required
    insert(User).values({ name: "Ben", nickname: null });
  });

  it("yields rows-affected (number) without returning", () => {
    expectTypeOf<RowOf<ReturnType<typeof insert<typeof User>>>>().toEqualTypeOf<number>();
  });

  it("yields the full row with bare returning()", () => {
    const q = insert(User).values({ name: "x", age: 1, nickname: null }).returning();
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{
      id: number;
      name: string;
      age: number;
      nickname: string | null;
    }>();
  });

  it("yields a Pick projection with returning(cols)", () => {
    const q = insert(User)
      .values({ name: "x", age: 1, nickname: null })
      .returning(["id"]);
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{ id: number }>();
  });
});

describe("Phase 2 UPDATE guard", () => {
  it("starts unguarded", () => {
    expectTypeOf<
      GuardOf<ReturnType<typeof update<typeof User>>>
    >().toEqualTypeOf<false>();
  });

  it("becomes guarded after where()", () => {
    const q = update(User).set({ age: 31 }).where({ id: 1 });
    expectTypeOf<GuardOf<typeof q>>().toEqualTypeOf<true>();
  });

  it("becomes guarded after explicit unguarded()", () => {
    const q = update(User).set({ age: 0 }).unguarded();
    expectTypeOf<GuardOf<typeof q>>().toEqualTypeOf<true>();
  });

  it("rejects setting a non-column", () => {
    // @ts-expect-error - `bogus` is not a column
    update(User).set({ bogus: 1 });
  });
});

describe("Phase 2 DELETE guard", () => {
  it("starts unguarded, guards after where()", () => {
    expectTypeOf<GuardOf<ReturnType<typeof del<typeof User>>>>().toEqualTypeOf<false>();
    const q = del(User).where({ id: 1 });
    expectTypeOf<GuardOf<typeof q>>().toEqualTypeOf<true>();
  });

  it("yields a Pick projection with returning(cols)", () => {
    const q = del(User).where({ id: 1 }).returning(["name"]);
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{ name: string }>();
  });
});
