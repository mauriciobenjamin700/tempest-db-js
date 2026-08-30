/**
 * tempest-db-js — migration CLI (programmatic core).
 *
 * `runMigrationCli(argv, config)` dispatches Alembic-style commands against a
 * driver + a set of migrations + (optionally) the models. It returns lines and
 * an exit code rather than touching `process`, so it is fully testable; a thin
 * `bin` wrapper just maps `process.argv`/`process.exit` onto it.
 */

import { type AsyncDriver, type SyncDriver, toAsyncDriver } from "../engine.js";
import type { ModelClass } from "../index.js";
import type { Dialect } from "../url.js";
import { generateMigration, makeRevisionId } from "./codegen.js";
import { renderOperation } from "./ddl.js";
import { diffSchema } from "./diff.js";
import { heads as graphHeads, topoOrder } from "./graph.js";
import { checkDriftAsync } from "./introspect.js";
import { reflectSchema } from "./ir.js";
import type { Operation } from "./operations.js";
import { type RenameCandidate, applyRenames, detectRenames } from "./renames.js";
import { replaySchema } from "./replay.js";
import { AsyncMigrationRunner, type Migration, Op } from "./runner.js";

/** Configuration the CLI operates against. */
export interface CliConfig {
  /**
   * The driver for the live database — sync (SQLite) or async (PostgreSQL,
   * MySQL). Both are accepted: the CLI adapts either to the async runner, so a
   * Postgres migration runs through the same commands as a SQLite one.
   */
  readonly driver: SyncDriver | AsyncDriver;
  readonly dialect: Dialect;
  readonly migrations: readonly Migration[];
  readonly models?: readonly ModelClass[];
  /** Timestamp string stamped on applied revisions (no wall clock here). */
  readonly appliedAt?: string;
}

/** The result of a CLI run. */
export interface CliResult {
  readonly code: number;
  readonly lines: string[];
}

/**
 * Identity helper for authoring a typed migration config file. Gives editor
 * autocompletion and type-checking on the object the `tempest-db` bin loads.
 *
 * @example
 * ```ts
 * // tempest-db.config.mjs
 * import { defineMigrationConfig } from "tempest-db-js/migrations";
 * import { NodeSqliteDriver } from "tempest-db-js";
 * import { migrations } from "./migrations/index.js";
 * import { User } from "./models.js";
 *
 * export default defineMigrationConfig({
 *   driver: NodeSqliteDriver.open("app.db"),
 *   dialect: "sqlite",
 *   migrations,
 *   models: [User],
 * });
 * ```
 *
 * @param config The migration config to pass through unchanged.
 * @returns The same config, typed as `CliConfig`.
 */
export function defineMigrationConfig(config: CliConfig): CliConfig {
  return config;
}

function ok(lines: string[]): CliResult {
  return { code: 0, lines };
}
function fail(lines: string[]): CliResult {
  return { code: 1, lines };
}

/**
 * Parse rename flags into explicit rename candidates.
 *
 * `--rename-table <from>:<to>` and `--rename-column <table>.<from>:<to>` may each
 * be repeated. Malformed specs are ignored (the safe drop + add stays).
 *
 * @param rest The command arguments.
 * @returns The explicitly requested renames.
 */
function parseRenameFlags(rest: readonly string[]): RenameCandidate[] {
  const out: RenameCandidate[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--rename-table") {
      const [from, to] = (rest[i + 1] ?? "").split(":");
      i += 1;
      if (from && to) out.push({ kind: "table", from, to });
    } else if (arg === "--rename-column") {
      const [left, to] = (rest[i + 1] ?? "").split(":");
      i += 1;
      const dot = left?.lastIndexOf(".") ?? -1;
      if (left && to && dot > 0) {
        out.push({
          kind: "column",
          table: left.slice(0, dot),
          from: left.slice(dot + 1),
          to,
        });
      }
    }
  }
  return out;
}

/** Pending migrations (DAG order) not yet applied. */
async function pending(
  config: CliConfig,
  runner: AsyncMigrationRunner,
): Promise<Migration[]> {
  const done = await runner.applied();
  return topoOrder(config.migrations).filter((m) => !done.has(m.revision));
}

/**
 * Run one CLI command.
 *
 * Commands: `current`, `history`, `heads`, `upgrade [--sql]`, `downgrade [N]`,
 * `check`, `revision -m <msg> [--autogenerate]`.
 *
 * Async for every dialect: the config's driver is adapted with
 * {@link toAsyncDriver}, so SQLite and PostgreSQL take the same path and the CLI
 * is not silently SQLite-only.
 *
 * @param argv The command and its arguments (without the program name).
 * @param config The driver, migrations, and models to operate on.
 * @returns Output lines and an exit code.
 */
export async function runMigrationCli(
  argv: readonly string[],
  config: CliConfig,
): Promise<CliResult> {
  const [command, ...rest] = argv;
  const driver = toAsyncDriver(config.driver);
  const runner = new AsyncMigrationRunner(driver, config.dialect);
  const appliedAt = config.appliedAt ?? "1970-01-01T00:00:00.000Z";

  switch (command) {
    case "current": {
      const applied = [...(await runner.applied())].sort();
      return ok(applied.length > 0 ? applied : ["(no migrations applied)"]);
    }

    case "heads":
      return ok(graphHeads(config.migrations));

    case "history": {
      const done = await runner.applied();
      return ok(
        topoOrder(config.migrations).map(
          (m) =>
            `${done.has(m.revision) ? "✓" : "·"} ${m.revision}${m.label ? ` — ${m.label}` : ""}`,
        ),
      );
    }

    case "upgrade": {
      if (rest.includes("--sql")) {
        const lines: string[] = [];
        for (const migration of await pending(config, runner)) {
          const op = new Op();
          migration.up(op);
          lines.push(`-- ${migration.revision}`);
          for (const operation of op.operations) {
            for (const stmt of renderOperation(operation, config.dialect))
              lines.push(`${stmt};`);
          }
        }
        return ok(lines.length > 0 ? lines : ["-- nothing to upgrade"]);
      }
      const ran = await runner.upgrade(config.migrations, appliedAt);
      return ok(ran.length > 0 ? ran.map((r) => `applied ${r}`) : ["nothing to upgrade"]);
    }

    case "downgrade": {
      const steps = rest[0] ? Number(rest[0]) : 1;
      const reverted = await runner.downgrade(config.migrations, steps);
      return ok(
        reverted.length > 0
          ? reverted.map((r) => `reverted ${r}`)
          : ["nothing to downgrade"],
      );
    }

    case "check": {
      if (!config.models) return fail(["check requires models in the config"]);
      const drift = await checkDriftAsync(driver, config.dialect, config.models);
      // Pending model changes not yet captured by a migration.
      const undiffed = diffSchema(
        replaySchema(config.migrations),
        reflectSchema(config.models),
      );
      const issues = [
        ...drift.map((d) => `drift: ${d}`),
        ...undiffed.map((o) => `uncaptured: ${o.kind}`),
      ];
      return issues.length > 0 ? fail(issues) : ok(["no drift; models match migrations"]);
    }

    case "revision": {
      if (!config.models)
        return fail(["revision --autogenerate requires models in the config"]);
      const msgIndex = rest.indexOf("-m");
      const label = msgIndex >= 0 ? (rest[msgIndex + 1] ?? "revision") : "revision";
      const parents = graphHeads(config.migrations);
      let ops: Operation[] = rest.includes("--autogenerate")
        ? diffSchema(replaySchema(config.migrations), reflectSchema(config.models))
        : [];
      if (rest.includes("--autogenerate")) {
        // Fold add/drop pairs into renames: `--autorename` accepts every
        // detected candidate; otherwise only the explicit `--rename-*` flags.
        const confirmed = rest.includes("--autorename")
          ? detectRenames(ops)
          : parseRenameFlags(rest);
        if (confirmed.length > 0) ops = applyRenames(ops, confirmed);
      }
      const source = generateMigration({
        revision: makeRevisionId(label, parents),
        downRevision: parents,
        label,
        operations: ops,
      });
      return ok(source.split("\n"));
    }

    default:
      return fail([
        `unknown command ${JSON.stringify(command)}`,
        "commands: current | history | heads | upgrade [--sql] | downgrade [N] | check | revision -m <msg> [--autogenerate]",
      ]);
  }
}
