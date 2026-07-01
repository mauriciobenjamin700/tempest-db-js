#!/usr/bin/env node
/**
 * tempest-db-js — `tempest-db` executable.
 *
 * A thin wrapper around {@link runMigrationCli}: it discovers a config module,
 * loads it, injects a real timestamp, dispatches the command, prints the output
 * lines, and maps the result code onto `process.exit`. All the migration logic
 * lives in the (fully testable) programmatic core — this file only touches
 * `process`, the filesystem, and the wall clock.
 *
 * @example
 * ```bash
 * tempest-db upgrade
 * tempest-db revision -m "add users" --autogenerate
 * tempest-db --config db/tempest.config.mjs current
 * ```
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CliConfig } from "./migrations/cli.js";
import { runMigrationCli } from "./migrations/cli.js";

/** Config file names looked up in the current directory, in order. */
const DEFAULT_CONFIG_NAMES: readonly string[] = [
  "tempest-db.config.mjs",
  "tempest-db.config.js",
  "tempest-db.config.cjs",
];

/**
 * Pull the `--config <path>` flag out of the argv, returning the path (if any)
 * and the remaining arguments for the CLI command itself.
 *
 * @param argv The process arguments (without node + script).
 * @returns The explicit config path (or `null`) and the leftover argv.
 */
function extractConfigFlag(argv: readonly string[]): {
  configPath: string | null;
  rest: string[];
} {
  const rest: string[] = [];
  let configPath: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" || arg === "-c") {
      configPath = argv[i + 1] ?? null;
      i += 1;
    } else if (arg?.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else if (arg !== undefined) {
      rest.push(arg);
    }
  }
  return { configPath, rest };
}

/**
 * Resolve the config file path: the explicit `--config` value, or the first of
 * the default names that exists in the current directory.
 *
 * @param explicit The `--config` value, or `null` to search defaults.
 * @returns The absolute config path, or `null` if none was found.
 */
function resolveConfigPath(explicit: string | null): string | null {
  if (explicit) return resolve(process.cwd(), explicit);
  for (const name of DEFAULT_CONFIG_NAMES) {
    const candidate = resolve(process.cwd(), name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Dynamically import a config module and extract the `CliConfig` from its
 * `default` export (or a named `config` export as a fallback).
 *
 * @param path The absolute path to the config module.
 * @returns The loaded migration config.
 * @throws If the module has neither a default nor a `config` export.
 */
async function loadConfig(path: string): Promise<CliConfig> {
  const mod = (await import(pathToFileURL(path).href)) as {
    default?: CliConfig;
    config?: CliConfig;
  };
  const config = mod.default ?? mod.config;
  if (!config) {
    throw new Error(
      `config at ${path} must default-export (or export \`config\`) a CliConfig`,
    );
  }
  return config;
}

/**
 * Run the `tempest-db` CLI end to end: discover + load the config, dispatch the
 * command, print output, and exit with the CLI's status code.
 *
 * @param argv The process arguments (without node + script).
 * @returns A promise resolving once the command has printed and exit is set.
 */
export async function main(argv: readonly string[]): Promise<void> {
  const { configPath, rest } = extractConfigFlag(argv);
  const resolved = resolveConfigPath(configPath);
  if (!resolved) {
    process.stderr.write(
      `tempest-db: no config found. Create one of ${DEFAULT_CONFIG_NAMES.join(
        ", ",
      )} or pass --config <path>.\n`,
    );
    process.exitCode = 1;
    return;
  }

  let config: CliConfig;
  try {
    config = await loadConfig(resolved);
  } catch (error) {
    process.stderr.write(`tempest-db: ${(error as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const withClock: CliConfig = {
    ...config,
    appliedAt: config.appliedAt ?? new Date().toISOString(),
  };
  const result = runMigrationCli(rest, withClock);
  const sink = result.code === 0 ? process.stdout : process.stderr;
  for (const line of result.lines) sink.write(`${line}\n`);
  process.exitCode = result.code;
}

// Only auto-run when invoked as a program (not when imported by a test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main(process.argv.slice(2));
}
