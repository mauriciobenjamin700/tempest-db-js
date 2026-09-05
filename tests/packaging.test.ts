/**
 * The core must exist **once** across the published entry points.
 *
 * `tempest-db-js` and `tempest-db-js/migrations` are separate bundles, and if
 * each carries its own `Column` class, a model built through one reflects as
 * having **no columns** in the other: `instanceof Column` compares two different
 * classes, and nothing throws — the CREATE TABLE just comes out empty and the
 * drift check sees nothing.
 *
 * This asserts on the **built** files, because the source is a single module
 * graph where the bug cannot appear.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const built = join(root, "dist", "index.cjs");

/** Build once, on demand, so the test works from a clean checkout. */
function ensureBuilt(): void {
  if (existsSync(built)) return;
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });
}

describe("packaging", () => {
  it("keeps the core in the root bundle only", () => {
    ensureBuilt();
    const rootBundle = readFileSync(built, "utf8");
    expect(rootBundle).toContain("columnsCache");

    for (const satellite of ["dist/migrations/index.cjs", "dist/bin.cjs"]) {
      const code = readFileSync(join(root, satellite), "utf8");
      expect(code, `${satellite} must not carry its own core`).not.toContain(
        "columnsCache",
      );
      expect(code, `${satellite} must load the core from the package`).toContain(
        "tempest-db-js",
      );
    }
  });

  it("reflects a model built through the root, from the migrations entry", () => {
    ensureBuilt();
    const script = `
      const t = require(${JSON.stringify(built)});
      const m = require(${JSON.stringify(join(root, "dist/migrations/index.cjs"))});
      class N extends t.Model {
        static tablename = "n";
        id = t.column.integer().primaryKey();
        total = t.column.integer().notNull();
      }
      process.stdout.write(Object.keys(m.reflectTable(N).columns).join(","));
    `;
    const columns = execFileSync("node", ["-e", script], { encoding: "utf8" });
    expect(columns).toBe("id,total");
  });
});
