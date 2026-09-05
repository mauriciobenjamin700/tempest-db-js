/**
 * PostgreSQL integration for `parseIntegrityError` — the shapes only the real
 * server produces: SQLSTATE codes, `constraint_name`, and the `DETAIL:` line a
 * composite key is reported through.
 *
 * Gated on `TEST_DATABASE_URL`; uses its own tables so it can run in parallel with
 * the other integration files.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AsyncDriver,
  type AsyncEngine,
  BaseRepository,
  Model,
  column,
  createEngine,
  parseIntegrityError,
  unique,
} from "../src/index.js";
import { reflectTable, renderOperation } from "../src/migrations/index.js";

const url = process.env.TEST_DATABASE_URL;

class IntegrityUser extends Model {
  static override tablename = "integrity_users";
  static override naming = "snake_case" as const;
  static override tableArgs = () => [unique("email", "tenantId")];
  id = column.integer().primaryKey();
  email = column.text().notNull();
  tenantId = column.integer().notNull();
  fullName = column.text().notNull();
  ownerId = column.integer().references("integrity_users.id");
}

/** Run a write and return the parsed failure, or null when it succeeded. */
async function failureOf(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    return parseIntegrityError(error, IntegrityUser);
  }
}

describe.skipIf(!url)("PostgreSQL — parseIntegrityError", () => {
  let engine: AsyncEngine;
  let driver: AsyncDriver;
  let repo: BaseRepository<typeof IntegrityUser>;

  beforeAll(async () => {
    engine = createEngine(url as string);
    driver = (engine as unknown as { driver: AsyncDriver }).driver;
    await driver.execute("DROP TABLE IF EXISTS integrity_users CASCADE", []);
    for (const stmt of renderOperation(
      { kind: "create_table", table: reflectTable(IntegrityUser) },
      "postgresql",
    )) {
      await driver.execute(stmt, []);
    }
    await driver.execute(
      "ALTER TABLE integrity_users ADD CONSTRAINT ck_integrity_users_email CHECK (email <> '')",
      [],
    );
    repo = new BaseRepository(IntegrityUser, engine.session());
    await repo.create({ id: 1, email: "a@b", tenantId: 7, fullName: "Ana" });
  });

  afterAll(async () => {
    await driver.execute("DROP TABLE IF EXISTS integrity_users CASCADE", []);
    await engine.close();
  });

  it("names the constraint and every column of a composite unique", async () => {
    const failure = await failureOf(() =>
      repo.create({ id: 2, email: "a@b", tenantId: 7, fullName: "Outro" }),
    );
    expect(failure?.violation).toBe("unique");
    expect(failure?.constraint).toBe("uq_integrity_users_email_tenant_id");
    expect(failure?.table).toBe("integrity_users");
    expect(failure?.columns).toEqual(["email", "tenantId"]);
  });

  it("reads a foreign-key violation", async () => {
    const failure = await failureOf(() =>
      repo.create({ id: 3, email: "c@d", tenantId: 7, fullName: "Orfa", ownerId: 999 }),
    );
    expect(failure?.violation).toBe("foreignKey");
    expect(failure?.columns).toEqual(["ownerId"]);
  });

  it("reads a not-null violation", async () => {
    const failure = await failureOf(() =>
      engine
        .session()
        .raw(
          "INSERT INTO integrity_users (id, email, tenant_id, full_name) VALUES ($1, $2, $3, $4)",
          [4, "e@f", 7, null],
        )
        .rowsAffected(),
    );
    expect(failure?.violation).toBe("notNull");
    expect(failure?.columns).toEqual(["fullName"]);
  });

  it("reads a check violation, with the constraint name", async () => {
    const failure = await failureOf(() =>
      repo.create({ id: 5, email: "", tenantId: 7, fullName: "Vazio" }),
    );
    expect(failure?.violation).toBe("check");
    expect(failure?.constraint).toBe("ck_integrity_users_email");
  });

  it("returns null for an error that is not an integrity violation", async () => {
    const failure = await failureOf(() =>
      engine.session().raw("SELECT * FROM does_not_exist").all(),
    );
    expect(failure).toBeNull();
  });
});
