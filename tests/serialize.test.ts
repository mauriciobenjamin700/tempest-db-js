import { describe, expect, it } from "vitest";
import {
  type InferModel,
  Model,
  ValidationError,
  column,
  fromDict,
  sql,
  toDict,
  toJSON,
} from "../src/index.js";

interface Prefs {
  theme: "light" | "dark";
}

class Account extends Model {
  static override tablename = "accounts";
  id = column.uuid().primaryKey().default(sql.uuidv4());
  handle = column.varchar(32).notNull();
  followers = column.bigInteger().notNull();
  balance = column.numeric(12, 2).notNull();
  prefs = column.json<Prefs>().notNull();
  avatar = column.blob();
  role = column.enum("admin", "user").notNull();
  createdAt = column.datetime({ timezone: true }).notNull().default(sql.now());
  updatedAt = column
    .datetime({ timezone: true })
    .notNull()
    .default(sql.now())
    .onUpdate(sql.now());
}

type AccountRow = InferModel<typeof Account>;

const row: AccountRow = {
  id: "11111111-1111-1111-1111-111111111111",
  handle: "ben",
  followers: 9007199254740993n, // beyond Number.MAX_SAFE_INTEGER
  balance: "1234.56",
  prefs: { theme: "dark" },
  avatar: new Uint8Array([1, 2, 3, 4]),
  role: "admin",
  createdAt: new Date("2026-06-29T12:00:00.000Z"),
  updatedAt: new Date("2026-06-29T12:00:00.000Z"),
};

describe("toJSON — encodes native values to JSON-safe forms", () => {
  it("turns bigint, Date and Uint8Array into JSON-safe values", () => {
    const json = toJSON(Account, row);
    expect(json.followers).toBe("9007199254740993"); // bigint → string
    expect(json.createdAt).toBe("2026-06-29T12:00:00.000Z"); // Date → ISO
    expect(typeof json.avatar).toBe("string"); // Uint8Array → base64
    expect(json.prefs).toEqual({ theme: "dark" }); // json passthrough
    expect(json.balance).toBe("1234.56"); // numeric stays string
  });

  it("round-trips through JSON.stringify without precision loss", () => {
    const restored = fromDict(Account, JSON.parse(JSON.stringify(toJSON(Account, row))));
    expect(restored.followers).toBe(9007199254740993n);
    expect(restored.createdAt).toEqual(new Date("2026-06-29T12:00:00.000Z"));
    expect(restored.avatar).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(restored.prefs).toEqual({ theme: "dark" });
  });
});

describe("toDict — native dict restricted to columns", () => {
  it("keeps native types and only column keys", () => {
    const dict = toDict(Account, { ...row, extra: "ignored" } as AccountRow);
    expect(dict.followers).toBe(9007199254740993n);
    expect(dict.createdAt).toBeInstanceOf(Date);
    expect("extra" in dict).toBe(false);
  });
});

describe("fromDict — builds and validates a row", () => {
  it("coerces strings back to native types", () => {
    const built = fromDict(Account, {
      id: "abc",
      handle: "ben",
      followers: "42",
      balance: 10, // number → string (numeric)
      prefs: '{"theme":"light"}', // JSON string → object
      avatar: null,
      role: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(built.followers).toBe(42n);
    expect(built.balance).toBe("10");
    expect(built.prefs).toEqual({ theme: "light" });
    expect(built.avatar).toBeNull();
    expect(built.createdAt).toBeInstanceOf(Date);
  });

  it("throws when a required column is missing", () => {
    expect(() =>
      fromDict(Account, {
        id: "x",
        followers: "1",
        balance: "0",
        prefs: {},
        role: "user",
      }),
    ).toThrow(ValidationError);
  });

  it("allows omitting columns that have a default", () => {
    // `id`, `createdAt`, `updatedAt` have defaults → optional
    const built = fromDict(Account, {
      handle: "ben",
      followers: "1",
      balance: "0",
      prefs: { theme: "dark" },
      role: "admin",
    });
    expect(built.handle).toBe("ben");
    expect(built.id).toBeNull(); // default applied at DB layer (Phase 4), null here
  });
});

describe("default storage feeds the migration IR", () => {
  it("records literal and expression defaults on the column", () => {
    const created = column.datetime().default(sql.now());
    expect(created.defaultValue).toEqual({ kind: "expression", expression: "now" });
    const active = column.boolean().default(true);
    expect(active.defaultValue).toEqual({ kind: "literal", value: true });
    const updated = column.datetime().onUpdate(sql.now());
    expect(updated.onUpdateValue).toEqual({ kind: "expression", expression: "now" });
  });
});
