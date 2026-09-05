import { beforeEach, describe, expect, it } from "vitest";
import {
  type AsyncEngine,
  BaseRepository,
  Model,
  column,
  createEngine,
  parseIntegrityError,
} from "../src/index.js";

class User extends Model {
  static override tablename = "users";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  email = column.varchar(80).unique();
  fullName = column.varchar(80).notNull();
  ownerId = column.integer().references("users.id");
}

const DDL = `CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE,
  full_name TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id),
  age INTEGER CHECK (age IS NULL OR age > 0)
)`;

const DRIVERS = ["node:sqlite", "better-sqlite3"] as const;

describe.each(DRIVERS)("parseIntegrityError on SQLite — %s", (driver) => {
  let engine: AsyncEngine;
  let repo: BaseRepository<typeof User>;

  beforeEach(async () => {
    engine = createEngine("sqlite://:memory:", { driver });
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL, []);
    repo = new BaseRepository(User, engine.session());
    await repo.create({ id: 1, email: "a@b", fullName: "Ana" });
  });

  it("reads a unique violation, with the column", async () => {
    const failure = await repo
      .create({ id: 2, email: "a@b", fullName: "Outro" })
      .then(() => null)
      .catch((error: unknown) => parseIntegrityError(error, User));
    expect(failure?.violation).toBe("unique");
    expect(failure?.table).toBe("users");
    expect(failure?.columns).toEqual(["email"]);
  });

  it("reads a primary-key collision as a unique violation", async () => {
    const failure = await repo
      .create({ id: 1, email: "c@d", fullName: "Dup" })
      .then(() => null)
      .catch((error: unknown) => parseIntegrityError(error, User));
    expect(failure?.violation).toBe("unique");
    expect(failure?.columns).toEqual(["id"]);
  });

  it("reads a not-null violation and maps the name back to the property", async () => {
    const failure = await engine
      .session()
      .raw("INSERT INTO users (id, email, full_name) VALUES (?, ?, ?)", [9, "z@z", null])
      .rowsAffected()
      .then(() => null)
      .catch((error: unknown) => parseIntegrityError(error, User));
    expect(failure?.violation).toBe("notNull");
    expect(failure?.columns).toEqual(["fullName"]);
  });

  it("reads a foreign-key violation", async () => {
    const failure = await repo
      .create({ id: 3, email: "e@f", fullName: "Orfa", ownerId: 999 })
      .then(() => null)
      .catch((error: unknown) => parseIntegrityError(error, User));
    expect(failure?.violation).toBe("foreignKey");
  });

  it("reads a check violation", async () => {
    const failure = await engine
      .session()
      .raw("INSERT INTO users (id, full_name, age) VALUES (?, ?, ?)", [4, "Neg", -1])
      .rowsAffected()
      .then(() => null)
      .catch((error: unknown) => parseIntegrityError(error, User));
    expect(failure?.violation).toBe("check");
  });

  it("returns null for anything that is not an integrity violation", async () => {
    const failure = await engine
      .session()
      .raw("SELECT * FROM nope")
      .all()
      .then(() => null)
      .catch((error: unknown) => parseIntegrityError(error, User));
    expect(failure).toBeNull();
    expect(parseIntegrityError(new Error("plain"))).toBeNull();
    expect(parseIntegrityError(null)).toBeNull();
    expect(parseIntegrityError("string")).toBeNull();
  });
});

describe("parseIntegrityError — shapes it does not own", () => {
  it("returns null for a MySQL duplicate, which is out of scope", () => {
    const mysqlError = Object.assign(new Error("Duplicate entry 'a@b' for key 'email'"), {
      code: "ER_DUP_ENTRY",
      errno: 1062,
    });
    expect(parseIntegrityError(mysqlError)).toBeNull();
  });

  it("classifies a PostgreSQL error shape without a database", () => {
    const pgError = Object.assign(
      new Error('duplicate key value violates unique constraint "uq_users_email"'),
      {
        code: "23505",
        constraint_name: "uq_users_email",
        table_name: "users",
        detail: "Key (email, tenant_id)=(a@b, 7) already exists.",
      },
    );
    const failure = parseIntegrityError(pgError);
    expect(failure).toEqual({
      violation: "unique",
      constraint: "uq_users_email",
      table: "users",
      columns: ["email", "tenant_id"],
      detail: 'duplicate key value violates unique constraint "uq_users_email"',
    });
  });

  it("follows the cause chain of a wrapped error", () => {
    const inner = Object.assign(new Error("boom"), {
      code: "23502",
      column_name: "name",
    });
    const outer = new Error("wrapped", { cause: new Error("mid", { cause: inner }) });
    expect(parseIntegrityError(outer)?.violation).toBe("notNull");
  });
});
