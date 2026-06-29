import { describe, expectTypeOf, it } from "vitest";
import { type InferInsert, type InferModel, Model, column } from "../src/index.js";

type Role = "admin" | "user" | "guest";

interface Settings {
  theme: "light" | "dark";
  notifications: boolean;
}

class Account extends Model {
  static override tablename = "accounts";
  id = column.uuid().primaryKey();
  handle = column.varchar(32).notNull();
  bio = column.text();
  followers = column.bigInteger().notNull();
  balance = column.numeric(12, 2).notNull();
  role = column.enum("admin", "user", "guest").notNull();
  settings = column.json<Settings>().notNull();
  avatar = column.blob();
  createdAt = column.timestamp({ timezone: true }).default(new Date());
}

type AccountRow = InferModel<typeof Account>;
type AccountInsert = InferInsert<typeof Account>;

describe("Rich column types map to the right TS types", () => {
  it("infers the row shape across SQLAlchemy-style types", () => {
    expectTypeOf<AccountRow>().toEqualTypeOf<{
      id: string; // uuid
      handle: string; // varchar(32)
      bio: string | null; // text, nullable
      followers: bigint; // bigInteger
      balance: string; // numeric → string (exact decimal)
      role: Role; // enum → literal union
      settings: Settings; // json<Settings>
      avatar: Uint8Array | null; // blob, nullable
      createdAt: Date | null; // timestamp, has default but nullable
    }>();
  });

  it("keeps the enum union narrow on insert", () => {
    expectTypeOf<AccountInsert["role"]>().toEqualTypeOf<Role>();
  });

  it("rejects an enum value outside the declared set", () => {
    const role = column.enum("admin", "user");
    // @ts-expect-error - "root" is not a declared enum value
    role.default("root");
  });
});

describe("Column type descriptor is preserved at runtime", () => {
  it("carries kind + meta for the migration IR", () => {
    const handle = column.varchar(32);
    expectTypeOf(handle.type.kind).toEqualTypeOf<
      | "smallint"
      | "integer"
      | "bigint"
      | "numeric"
      | "real"
      | "double"
      | "varchar"
      | "text"
      | "char"
      | "boolean"
      | "date"
      | "time"
      | "datetime"
      | "timestamp"
      | "blob"
      | "json"
      | "uuid"
      | "enum"
    >();
  });
});
