import type { Plugin } from "esbuild";
import { defineConfig } from "tsup";

/**
 * Keep the core out of the satellite bundles.
 *
 * `tempest-db-js/migrations` and the `tempest-db` binary must share the **one**
 * `Column` class, model cache and signal registry the root bundle defines. Left
 * to itself, esbuild inlines a private copy of the core into every entry, and a
 * model built through the root then reflects as having **no columns** in the
 * migration engine — `instanceof Column` compares two different classes, and the
 * failure is silent: an empty `CREATE TABLE`, a drift check that sees nothing.
 *
 * The import is rewritten to the package's **own name** rather than left
 * relative: esbuild rebases a relative external against the output file, which
 * turned `../index.js` into a self-import for `dist/migrations/index.js`. A
 * self-reference by name resolves through the package's `exports` map from any
 * depth, in `dist/` and in a consumer's `node_modules` alike.
 */
const shareCore: Plugin = {
  name: "share-core",
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\/index\.js$/ }, () => ({
      path: "tempest-db-js",
      external: true,
    }));
  },
};

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    target: "es2022",
  },
  {
    entry: ["src/migrations/index.ts", "src/bin.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: false,
    treeshake: true,
    target: "es2022",
    esbuildPlugins: [shareCore],
  },
]);
