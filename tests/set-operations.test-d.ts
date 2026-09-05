import { describe, expectTypeOf, it } from "vitest";
import { type InferModel, Model, column, select, union } from "../src/index.js";

class Post extends Model {
  static override tablename = "posts";
  id = column.integer().primaryKey();
  authorId = column.integer().notNull();
  title = column.text().notNull();
}

class Comment extends Model {
  static override tablename = "comments";
  id = column.integer().primaryKey();
  authorId = column.integer().notNull();
  body = column.text().notNull();
}

describe("set operations — types", () => {
  it("keeps the projected row type of the branches", () => {
    const combined = union(
      select(Post, ["id", "authorId"]),
      select(Comment, ["id", "authorId"]),
    );
    expectTypeOf(combined.__row).toEqualTypeOf<{ id: number; authorId: number }>();
  });

  it("rejects branches whose projections do not line up", () => {
    // @ts-expect-error — one branch projects `title`, the other `body`.
    union(select(Post, ["id", "title"]), select(Comment, ["id", "body"]));
  });

  it("rejects an orderBy key that is not in the projection", () => {
    const combined = union(select(Post, ["id"]), select(Comment, ["id"]));
    // @ts-expect-error — "title" is not projected by the combined query.
    combined.orderBy("title");
  });

  it("infers the full row when no projection narrows it", () => {
    const combined = union(select(Post), select(Post).where({ authorId: 1 }));
    expectTypeOf(combined.__row).toEqualTypeOf<InferModel<typeof Post>>();
  });
});
