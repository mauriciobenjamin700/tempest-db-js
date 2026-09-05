import { describe, expectTypeOf, it } from "vitest";
import {
  type InferInsert,
  type InferModel,
  Model,
  column,
  withAudit,
  withSoftDelete,
  withTimestamps,
} from "../src/index.js";

class Note extends withSoftDelete(withTimestamps(Model)) {
  static override tablename = "notes";
  id = column.integer().primaryKey();
  title = column.varchar(80).notNull();
}

class Doc extends withAudit(Model, () => column.integer()) {
  static override tablename = "docs";
  id = column.integer().primaryKey();
}

describe("model mixins — types", () => {
  it("contributes the columns to the row type", () => {
    expectTypeOf<InferModel<typeof Note>>().toEqualTypeOf<{
      createdAt: Date;
      updatedAt: Date;
      deletedAt: Date | null;
      id: number;
      title: string;
    }>();
  });

  it("leaves defaulted and nullable mixin columns optional on insert", () => {
    expectTypeOf<InferInsert<typeof Note>>().toEqualTypeOf<{
      createdAt?: Date;
      updatedAt?: Date;
      deletedAt?: Date | null;
      id?: number;
      title: string;
    }>();
  });

  it("types the actor column from the factory", () => {
    expectTypeOf<InferModel<typeof Doc>>().toEqualTypeOf<{
      createdBy: number | null;
      updatedBy: number | null;
      id: number;
    }>();
  });
});
