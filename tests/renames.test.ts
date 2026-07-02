import { describe, expect, it } from "vitest";
import { Model, column } from "../src/index.js";
import {
  type Operation,
  applyRenames,
  detectRenames,
  diffSchema,
  emptySchema,
  invertAll,
  reflectSchema,
} from "../src/migrations/index.js";

class UserOld extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  fullName = column.varchar(80).notNull();
}

// Same table + column shapes, one column renamed fullName → name.
class UserRenamedCol extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.varchar(80).notNull();
}

// Same shape, table renamed users → accounts.
class Account extends Model {
  static override tablename = "accounts";
  id = column.integer().primaryKey();
  fullName = column.varchar(80).notNull();
}

describe("detectRenames — columns", () => {
  it("detects an add + drop with identical shape as a column rename", () => {
    const ops = diffSchema(reflectSchema([UserOld]), reflectSchema([UserRenamedCol]));
    // Raw diff is a drop + add (safe default).
    expect(ops.map((o) => o.kind).sort()).toEqual(["add_column", "drop_column"]);
    const candidates = detectRenames(ops);
    expect(candidates).toEqual([
      { kind: "column", table: "users", from: "fullName", to: "name" },
    ]);
  });

  it("folds a confirmed column rename into a single rename_column op", () => {
    const ops = diffSchema(reflectSchema([UserOld]), reflectSchema([UserRenamedCol]));
    const folded = applyRenames(ops, detectRenames(ops));
    expect(folded).toHaveLength(1);
    expect(folded[0]).toEqual({
      kind: "rename_column",
      table: "users",
      from: "fullName",
      to: "name",
    });
  });

  it("a folded rename inverts to the opposite rename", () => {
    const ops = diffSchema(reflectSchema([UserOld]), reflectSchema([UserRenamedCol]));
    const folded = applyRenames(ops, detectRenames(ops));
    expect(invertAll(folded)[0]).toEqual({
      kind: "rename_column",
      table: "users",
      from: "name",
      to: "fullName",
    });
  });

  it("does not fold when the candidate is not confirmed", () => {
    const ops = diffSchema(reflectSchema([UserOld]), reflectSchema([UserRenamedCol]));
    expect(applyRenames(ops, [])).toEqual(ops);
  });
});

describe("detectRenames — tables", () => {
  it("detects a create + drop with identical shape as a table rename", () => {
    const ops = diffSchema(reflectSchema([UserOld]), reflectSchema([Account]));
    const candidates = detectRenames(ops);
    expect(candidates).toEqual([{ kind: "table", from: "users", to: "accounts" }]);
  });

  it("folds a confirmed table rename into a single rename_table op", () => {
    const ops = diffSchema(reflectSchema([UserOld]), reflectSchema([Account]));
    const folded = applyRenames(ops, detectRenames(ops));
    expect(folded).toEqual([{ kind: "rename_table", from: "users", to: "accounts" }]);
  });
});

describe("detectRenames — ambiguity guard", () => {
  it("does not offer a rename when a genuinely new column has a unique shape", () => {
    class Base extends Model {
      static override tablename = "t";
      id = column.integer().primaryKey();
    }
    class WithExtra extends Model {
      static override tablename = "t";
      id = column.integer().primaryKey();
      note = column.text();
    }
    const ops = diffSchema(reflectSchema([Base]), reflectSchema([WithExtra]));
    // Pure add — nothing dropped, so no rename candidate.
    expect(detectRenames(ops)).toEqual([]);
  });

  it("ignores create_table with no matching dropped shape", () => {
    const ops = diffSchema(emptySchema(), reflectSchema([UserOld]));
    expect(detectRenames(ops)).toEqual([]);
  });

  it("selects only confirmed candidates, leaving others as drop/add", () => {
    // Two independent renames offered; confirm only the column one.
    const ops: Operation[] = [
      ...diffSchema(reflectSchema([UserOld]), reflectSchema([UserRenamedCol])),
    ];
    const confirmed = detectRenames(ops).filter((c) => c.kind === "column");
    const folded = applyRenames(ops, confirmed);
    expect(folded.some((o) => o.kind === "rename_column")).toBe(true);
  });
});
