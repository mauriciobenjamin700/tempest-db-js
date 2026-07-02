import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/bin.js";

const CONFIG = fileURLToPath(new URL("./fixtures/tempest-db.config.ts", import.meta.url));

/** Capture everything written to stdout/stderr during `fn`. */
async function captureIo(
  fn: () => Promise<void>,
): Promise<{ out: string; err: string; code: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    });
  const prev = process.exitCode;
  process.exitCode = undefined;
  try {
    await fn();
    return { out: out.join(""), err: err.join(""), code: process.exitCode };
  } finally {
    process.exitCode = prev;
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe("tempest-db bin — main()", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("dispatches a command against an explicit --config", async () => {
    const { out, code } = await captureIo(() => main(["--config", CONFIG, "heads"]));
    expect(out.trim()).toBe("0001_init");
    expect(code ?? 0).toBe(0);
  });

  it("supports --config=<path> form", async () => {
    const { out } = await captureIo(() => main([`--config=${CONFIG}`, "current"]));
    expect(out).toContain("(no migrations applied)");
  });

  it("runs an upgrade through the loaded driver", async () => {
    // Proves the loaded config's live driver is actually executed end to end.
    const { out, code } = await captureIo(() => main(["--config", CONFIG, "upgrade"]));
    expect(out).toContain("applied 0001_init");
    expect(code ?? 0).toBe(0);
  });

  it("exits non-zero on an unknown command", async () => {
    const { err, code } = await captureIo(() => main(["--config", CONFIG, "bogus"]));
    expect(err).toContain("unknown command");
    expect(code).toBe(1);
  });

  it("exits non-zero when no config is found", async () => {
    process.chdir(fileURLToPath(new URL("./fixtures/empty/", import.meta.url)));
    const { err, code } = await captureIo(() => main(["current"]));
    expect(err).toContain("no config found");
    expect(code).toBe(1);
  });

  it("exits non-zero when the config path does not exist", async () => {
    const { err, code } = await captureIo(() =>
      main(["--config", "./does-not-exist.mjs", "heads"]),
    );
    expect(err.toLowerCase()).toContain("tempest-db:");
    expect(code).toBe(1);
  });
});
