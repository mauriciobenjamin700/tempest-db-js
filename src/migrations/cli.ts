/**
 * tempest-db-js — migration CLI (programmatic core).
 *
 * `runMigrationCli(argv, config)` dispatches Alembic-style commands against a
 * driver + a set of migrations + (optionally) the models. It returns lines and
 * an exit code rather than touching `process`, so it is fully testable; a thin
 * `bin` wrapper just maps `process.argv`/`process.exit` onto it.
 */

import type { SyncDriver } from "../engine.js";
import type { ModelClass } from "../index.js";
import type { Dialect } from "../url.js";
import { generateMigration, makeRevisionId } from "./codegen.js";
import { renderOperation } from "./ddl.js";
import { diffSchema } from "./diff.js";
import { heads as graphHeads, topoOrder } from "./graph.js";
import { checkDrift } from "./introspect.js";
import { reflectSchema } from "./ir.js";
import { replaySchema } from "./replay.js";
import { type Migration, MigrationRunner, Op } from "./runner.js";

/** Configuration the CLI operates against. */
export interface CliConfig {
  readonly driver: SyncDriver;
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

/** Pending migrations (DAG order) not yet applied. */
function pending(config: CliConfig, runner: MigrationRunner): Migration[] {
  const done = runner.applied();
  return topoOrder(config.migrations).filter((m) => !done.has(m.revision));
}

/**
 * Run one CLI command.
 *
 * Commands: `current`, `history`, `heads`, `upgrade [--sql]`, `downgrade [N]`,
 * `check`, `revision -m <msg> [--autogenerate]`.
 *
 * @param argv The command and its arguments (without the program name).
 * @param config The driver, migrations, and models to operate on.
 * @returns Output lines and an exit code.
 */
export function runMigrationCli(argv: readonly string[], config: CliConfig): CliResult {
  const [command, ...rest] = argv;
  const runner = new MigrationRunner(config.driver, config.dialect);
  const appliedAt = config.appliedAt ?? "1970-01-01T00:00:00.000Z";

  switch (command) {
    case "current": {
      const applied = [...runner.applied()].sort();
      return ok(applied.length > 0 ? applied : ["(no migrations applied)"]);
    }

    case "heads":
      return ok(graphHeads(config.migrations));

    case "history": {
      const done = runner.applied();
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
        for (const migration of pending(config, runner)) {
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
      const ran = runner.upgrade(config.migrations, appliedAt);
      return ok(ran.length > 0 ? ran.map((r) => `applied ${r}`) : ["nothing to upgrade"]);
    }

    case "downgrade": {
      const steps = rest[0] ? Number(rest[0]) : 1;
      const reverted = runner.downgrade(config.migrations, steps);
      return ok(
        reverted.length > 0
          ? reverted.map((r) => `reverted ${r}`)
          : ["nothing to downgrade"],
      );
    }

    case "check": {
      if (!config.models) return fail(["check requires models in the config"]);
      // Drift: live DB vs models (SQLite introspection).
      const drift =
        config.dialect === "sqlite" ? checkDrift(config.driver, config.models) : [];
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
      const ops = rest.includes("--autogenerate")
        ? diffSchema(replaySchema(config.migrations), reflectSchema(config.models))
        : [];
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
