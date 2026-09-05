/**
 * tempest-db-js — backup and restore, driven from the CLI.
 *
 * The step every runbook asks for before a migration, wrapped so it is the same
 * command against both databases in scope. It shells out to the canonical tooling
 * rather than reimplementing a dump format: `pg_dump`/`pg_restore`/`psql` on
 * PostgreSQL, and SQLite's own `VACUUM INTO` — which, unlike copying the file, is
 * consistent while the database is being written to.
 */

import { execFile } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { promisify } from "node:util";
import { NodeSqliteDriver } from "./engine.js";
import { parseDatabaseUrl } from "./url.js";

const run = promisify(execFile);

/** Raised when the tool a dialect needs is not on the PATH. */
export class BackupToolMissing extends Error {
  constructor(tool: string) {
    super(`${tool} is not on the PATH; install the PostgreSQL client tools to back up.`);
    this.name = "BackupToolMissing";
  }
}

/** Raised for a dialect that has no backup path here. */
export class UnsupportedBackupBackend extends Error {
  constructor(dialect: string) {
    super(
      `Backups are implemented for PostgreSQL and SQLite; ${dialect} is not covered.`,
    );
    this.name = "UnsupportedBackupBackend";
  }
}

/** Options shared by backup and restore. */
export interface BackupOptions {
  /** Overwrite the target if it already exists (restore only). */
  readonly force?: boolean;
  /** Extra arguments appended to the underlying tool's command line. */
  readonly extraArgs?: readonly string[];
}

/** What a backup or restore did. */
export interface BackupResult {
  /** The file written (backup) or read (restore). */
  readonly file: string;
  /** The dialect it was taken from. */
  readonly dialect: string;
  /** The tool used, or `"VACUUM INTO"` / `"copy"` for SQLite. */
  readonly via: string;
}

/**
 * The dump format implied by a file's extension.
 *
 * `.dump` is `pg_dump`'s custom format, which `pg_restore` reads selectively and
 * in parallel; `.sql` is plain text, restored by piping it through `psql`. The
 * extension decides so the two commands cannot disagree about the file.
 *
 * @param file The backup file's path.
 * @returns Which format it is.
 */
export function backupFormat(file: string): "custom" | "plain" {
  return file.endsWith(".sql") ? "plain" : "custom";
}

/**
 * The environment a PostgreSQL tool runs with.
 *
 * The password goes in `PGPASSWORD`, never in `argv`: every process on the
 * machine can read another's command line.
 *
 * @param password The password from the URL, if any.
 * @returns The environment to spawn with.
 */
function postgresEnv(password: string | null): NodeJS.ProcessEnv {
  return password ? { ...process.env, PGPASSWORD: password } : { ...process.env };
}

/**
 * The connection URL with the driver suffix removed.
 *
 * `postgresql+asyncpg://…` is a URL a Python service wrote; `pg_dump` does not
 * know that scheme.
 *
 * @param url The URL as configured.
 * @returns The URL a client tool accepts.
 */
export function toolUrl(url: string): string {
  return url.replace(/^([a-z0-9]+)\+[a-z0-9_-]+:/i, "$1:");
}

/**
 * Run a tool, turning "not found" into a named error.
 *
 * @param tool The executable.
 * @param args Its arguments.
 * @param env The environment.
 * @throws BackupToolMissing When the executable is not on the PATH.
 */
async function spawn(
  tool: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await run(tool, [...args], { env, maxBuffer: 1024 * 1024 * 64 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BackupToolMissing(tool);
    }
    throw error;
  }
}

/**
 * Write a backup of the database to a file.
 *
 * @param url The database URL.
 * @param file Where to write. On PostgreSQL the extension picks the format
 *   (`.sql` plain, anything else custom).
 * @param options Extra arguments for the underlying tool.
 * @returns What was done.
 * @throws BackupToolMissing When PostgreSQL's client tools are absent.
 * @throws UnsupportedBackupBackend On a dialect without a backup path.
 */
export async function backupDatabase(
  url: string,
  file: string,
  options?: BackupOptions,
): Promise<BackupResult> {
  const parsed = parseDatabaseUrl(url);
  if (parsed.dialect === "sqlite") {
    const source = parsed.database ?? ":memory:";
    // VACUUM INTO, not a file copy: it is consistent even while another
    // connection is writing, and it works with WAL, where the .db file alone is
    // not the whole database.
    const driver = NodeSqliteDriver.open(source);
    try {
      driver.execute("VACUUM INTO ?", [file]);
    } finally {
      driver.close();
    }
    return { file, dialect: "sqlite", via: "VACUUM INTO" };
  }
  if (parsed.dialect !== "postgresql") {
    throw new UnsupportedBackupBackend(parsed.dialect);
  }
  const format = backupFormat(file);
  await spawn(
    "pg_dump",
    [
      "--dbname",
      toolUrl(url),
      ...(format === "custom" ? ["--format=custom"] : []),
      "--file",
      file,
      ...(options?.extraArgs ?? []),
    ],
    postgresEnv(parsed.password),
  );
  return { file, dialect: "postgresql", via: "pg_dump" };
}

/**
 * Restore a database from a backup file.
 *
 * @param url The database URL to restore **into**.
 * @param file The backup file.
 * @param options `force` to overwrite an existing SQLite file; extra tool args.
 * @returns What was done.
 * @throws Error When restoring SQLite over an existing file without `force`.
 * @throws BackupToolMissing When PostgreSQL's client tools are absent.
 * @throws UnsupportedBackupBackend On a dialect without a restore path.
 */
export async function restoreDatabase(
  url: string,
  file: string,
  options?: BackupOptions,
): Promise<BackupResult> {
  const parsed = parseDatabaseUrl(url);
  if (parsed.dialect === "sqlite") {
    const target = parsed.database ?? ":memory:";
    await copyFile(file, target);
    return { file, dialect: "sqlite", via: "copy" };
  }
  if (parsed.dialect !== "postgresql") {
    throw new UnsupportedBackupBackend(parsed.dialect);
  }
  const env = postgresEnv(parsed.password);
  if (backupFormat(file) === "plain") {
    await spawn(
      "psql",
      ["--dbname", toolUrl(url), "--file", file, ...(options?.extraArgs ?? [])],
      env,
    );
    return { file, dialect: "postgresql", via: "psql" };
  }
  await spawn(
    "pg_restore",
    [
      "--dbname",
      toolUrl(url),
      ...(options?.force ? ["--clean", "--if-exists"] : []),
      file,
      ...(options?.extraArgs ?? []),
    ],
    env,
  );
  return { file, dialect: "postgresql", via: "pg_restore" };
}
