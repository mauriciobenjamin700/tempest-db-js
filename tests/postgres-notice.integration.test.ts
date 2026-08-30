/**
 * PostgreSQL `NOTICE` routing.
 *
 * postgres.js defaults `onnotice` to `console.log`, so a statement as ordinary as
 * `CREATE TABLE IF NOT EXISTS` on an existing table prints a nine-line object
 * into the host service's stdout — in the middle of its structured log, on every
 * boot. These tests pin both halves of the fix: silent by default, routed when
 * the application asks.
 *
 * Gated on `TEST_DATABASE_URL`, like the other PostgreSQL suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AsyncEngine, createEngine } from "../src/index.js";

const url = process.env.TEST_DATABASE_URL;

/** The statement PostgreSQL answers with `relation ... already exists, skipping`. */
const CREATE_IF_NOT_EXISTS =
  "CREATE TABLE IF NOT EXISTS notice_probe (id integer PRIMARY KEY)";

/**
 * Collect everything the library would print while `run` executes.
 *
 * postgres.js's default notice handler is `console.log`, and vitest replaces
 * `console` rather than letting it reach `process.stdout` — so capturing only
 * `process.stdout.write` here would pass with or without the fix. Both are
 * captured, and `console` is the one that actually catches the regression.
 */
async function capturePrinted(run: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  const originalInfo = console.info;
  let captured = "";
  const record = (...args: unknown[]): void => {
    captured += `${args.map((a) => String(a)).join(" ")}\n`;
  };
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  console.log = record;
  console.info = record;
  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    console.info = originalInfo;
  }
  return captured;
}

describe.skipIf(!url)("PostgreSQL notices", () => {
  let setup: AsyncEngine;

  beforeAll(async () => {
    setup = createEngine(url as string);
    await setup.session().raw("DROP TABLE IF EXISTS notice_probe").rowsAffected();
    await setup.session().raw(CREATE_IF_NOT_EXISTS).rowsAffected();
  });

  afterAll(async () => {
    await setup.session().raw("DROP TABLE IF EXISTS notice_probe").rowsAffected();
    await setup.close();
  });

  it("writes nothing to stdout by default", async () => {
    const engine = createEngine(url as string);
    const written = await capturePrinted(async () => {
      await engine.session().raw(CREATE_IF_NOT_EXISTS).rowsAffected();
    });
    await engine.close();
    expect(written).toBe("");
  });

  it("hands the notice to onNotice instead", async () => {
    const notices: Record<string, unknown>[] = [];
    const engine = createEngine(url as string, {
      onNotice: (notice) => notices.push(notice),
    });
    const written = await capturePrinted(async () => {
      await engine.session().raw(CREATE_IF_NOT_EXISTS).rowsAffected();
    });
    await engine.close();

    expect(written).toBe("");
    expect(notices).toHaveLength(1);
    expect(String(notices[0]?.message)).toContain("already exists, skipping");
    expect(notices[0]?.severity).toBe("NOTICE");
  });

  it("keeps working when the notice logger throws", async () => {
    const engine = createEngine(url as string, {
      onNotice: () => {
        throw new Error("logger blew up");
      },
    });
    const rows = await engine.session().raw<{ ok: number }>("SELECT 1 AS ok").all();
    await engine.session().raw(CREATE_IF_NOT_EXISTS).rowsAffected();
    await engine.close();
    expect(rows[0]?.ok).toBe(1);
  });

  it("lets driverOptions override the derived options", async () => {
    const seen: Record<string, unknown>[] = [];
    const engine = createEngine(url as string, {
      onNotice: () => {
        throw new Error("should be overridden");
      },
      driverOptions: {
        onnotice: (notice: Record<string, unknown>) => {
          seen.push(notice);
        },
      },
    });
    await engine.session().raw(CREATE_IF_NOT_EXISTS).rowsAffected();
    await engine.close();
    expect(seen).toHaveLength(1);
  });
});
