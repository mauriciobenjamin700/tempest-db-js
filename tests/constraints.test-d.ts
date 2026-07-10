import { describe, expectTypeOf, it } from "vitest";
import { type InferInsert, type InferModel, Model, column } from "../src/index.js";

class Post extends Model {
  static override tablename = "posts";
  id = column.integer().primaryKey();
  email = column.varchar(120).notNull().unique();
  authorId = column.integer().notNull().references("users.id", { onDelete: "cascade" });
  slug = column.varchar(80).unique(); // unique but nullable
}

type PostRow = InferModel<typeof Post>;
type PostInsert = InferInsert<typeof Post>;

describe(".unique() / .references() do not change inference", () => {
  it("keeps the row shape identical to plain columns", () => {
    expectTypeOf<PostRow>().toEqualTypeOf<{
      id: number;
      email: string; // notNull → non-nullable, unique irrelevant
      authorId: number; // notNull + references → still number
      slug: string | null; // nullable, unique irrelevant
    }>();
  });

  it("keeps insert optionality driven only by default/PK", () => {
    // id is PK (optional); everything else without a default is required
    // (unique/references never make a column optional or nullable on insert).
    expectTypeOf<PostInsert>().toEqualTypeOf<{
      id?: number;
      email: string;
      authorId: number;
      slug: string | null;
    }>();
  });
});
