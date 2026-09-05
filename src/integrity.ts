/**
 * tempest-db-js — read a constraint violation back out of the driver's error.
 *
 * A database says *why* it refused a write, and says it in prose whose shape is
 * the driver's, not the application's. Answering `409 {"code":"EMAIL_TAKEN"}`
 * instead of a generic conflict otherwise means every service writing its own
 * regular expression against whichever dialect the author had running.
 *
 * The two dialects in scope say the same five things two different ways:
 * PostgreSQL names the constraint and lists the columns in a `DETAIL:` line,
 * while SQLite spells the table and columns into the message and says nothing
 * about the constraint's name.
 */

import { type ModelClass, columnPropsOf } from "./index.js";

/** What kind of constraint refused the write. */
export type IntegrityViolation =
  | "unique"
  | "foreignKey"
  | "notNull"
  | "check"
  | "exclusion";

/** A constraint violation, read out of the driver's error. */
export interface IntegrityFailure {
  /** Which kind of constraint refused the write. */
  readonly violation: IntegrityViolation;
  /** The constraint's name, when the database reported one (PostgreSQL does). */
  readonly constraint: string | null;
  /** The table, when the database reported one. */
  readonly table: string | null;
  /**
   * The columns the constraint covers.
   *
   * Empty when the database did not say — a SQLite `FOREIGN KEY constraint
   * failed` carries no names at all.
   */
  readonly columns: readonly string[];
  /** The driver's own message, kept verbatim for logging. */
  readonly detail: string;
}

/** SQLSTATE codes for the integrity classes PostgreSQL reports. */
const POSTGRES_VIOLATIONS: Readonly<Record<string, IntegrityViolation>> = {
  "23505": "unique",
  "23503": "foreignKey",
  "23502": "notNull",
  "23514": "check",
  "23P01": "exclusion",
};

/** SQLite extended result codes, as `node:sqlite` reports them numerically. */
const SQLITE_ERRCODES: Readonly<Record<number, IntegrityViolation>> = {
  1555: "unique", // SQLITE_CONSTRAINT_PRIMARYKEY
  2067: "unique", // SQLITE_CONSTRAINT_UNIQUE
  787: "foreignKey", // SQLITE_CONSTRAINT_FOREIGNKEY
  1299: "notNull", // SQLITE_CONSTRAINT_NOTNULL
  275: "check", // SQLITE_CONSTRAINT_CHECK
};

/** SQLite extended result codes, as `better-sqlite3` reports them by name. */
const SQLITE_CODES: Readonly<Record<string, IntegrityViolation>> = {
  SQLITE_CONSTRAINT_PRIMARYKEY: "unique",
  SQLITE_CONSTRAINT_UNIQUE: "unique",
  SQLITE_CONSTRAINT_FOREIGNKEY: "foreignKey",
  SQLITE_CONSTRAINT_NOTNULL: "notNull",
  SQLITE_CONSTRAINT_CHECK: "check",
};

/** Read the string property `key` off an unknown error, if it has one. */
function str(error: Record<string, unknown>, key: string): string | null {
  const value = error[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Pull the column list out of a PostgreSQL `DETAIL:` line.
 *
 * `Key (email)=(a@b) already exists.` → `["email"]`, and a composite key lists
 * every column, which is why this exists instead of reading `column_name`.
 */
function postgresDetailColumns(detail: string | null): string[] {
  if (!detail) return [];
  const match = /Key \(([^)]+)\)=/.exec(detail);
  if (!match?.[1]) return [];
  return match[1].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
}

/** Split SQLite's `table.column, table.column` list into table + columns. */
function sqliteTargets(list: string): { table: string | null; columns: string[] } {
  const columns: string[] = [];
  let table: string | null = null;
  for (const entry of list.split(",")) {
    const [left, right] = entry.trim().split(".");
    if (right === undefined) {
      if (left) columns.push(left);
      continue;
    }
    table = left ?? null;
    columns.push(right);
  }
  return { table, columns };
}

/** Classify a PostgreSQL error, or return `null` when it is not an integrity one. */
function fromPostgres(error: Record<string, unknown>): IntegrityFailure | null {
  const code = str(error, "code");
  const violation = code ? POSTGRES_VIOLATIONS[code] : undefined;
  if (!violation) return null;
  const detail = str(error, "detail");
  const columns = postgresDetailColumns(detail);
  const column = str(error, "column_name");
  return {
    violation,
    constraint: str(error, "constraint_name"),
    table: str(error, "table_name"),
    columns: columns.length > 0 ? columns : column ? [column] : [],
    detail: str(error, "message") ?? detail ?? "",
  };
}

/** Classify a SQLite error from either driver, or return `null`. */
function fromSqlite(error: Record<string, unknown>): IntegrityFailure | null {
  const code = str(error, "code");
  const errcode = error.errcode;
  const violation =
    (code ? SQLITE_CODES[code] : undefined) ??
    (typeof errcode === "number" ? SQLITE_ERRCODES[errcode] : undefined);
  if (!violation) return null;
  const message = str(error, "message") ?? "";
  if (violation === "check") {
    const named = /CHECK constraint failed: (.+)$/.exec(message);
    return {
      violation,
      constraint: named?.[1] ?? null,
      table: null,
      columns: [],
      detail: message,
    };
  }
  const targets = /constraint failed: (.+)$/.exec(message);
  if (!targets?.[1]) {
    return { violation, constraint: null, table: null, columns: [], detail: message };
  }
  const { table, columns } = sqliteTargets(targets[1]);
  return { violation, constraint: null, table, columns, detail: message };
}

/**
 * Read a driver error back into the constraint that refused the write.
 *
 * @param error Anything thrown by a write — a `QueryExecutionError` from this
 *   package, or the driver's own error; the cause chain is followed either way.
 * @param model Optional. When given, database column names are translated back to
 *   the model's property names, so a `snake_case` schema reports `idempotencyKey`
 *   rather than `idempotency_key`.
 * @returns The violation, or `null` when the error is not an integrity violation
 *   (or came from MySQL, which is out of scope — see the recipe).
 *
 * @example
 * ```ts
 * try {
 *   await users.create({ email });
 * } catch (err) {
 *   const failure = parseIntegrityError(err, User);
 *   if (failure?.violation === "unique" && failure.columns.includes("email")) {
 *     throw new EmailTaken();
 *   }
 *   throw err;
 * }
 * ```
 */
export function parseIntegrityError(
  error: unknown,
  model?: ModelClass,
): IntegrityFailure | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth++) {
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      const failure = fromPostgres(record) ?? fromSqlite(record);
      if (failure) return model ? withModelNames(failure, model) : failure;
      current = record.cause;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Translate database column names back to the model's property names.
 *
 * @param failure The failure as the driver described it.
 * @param model The model whose naming applies.
 * @returns The failure with property names, unchanged when the model renames nothing.
 */
function withModelNames(failure: IntegrityFailure, model: ModelClass): IntegrityFailure {
  const props = columnPropsOf(model);
  if (!props || failure.columns.length === 0) return failure;
  return { ...failure, columns: failure.columns.map((c) => props[c] ?? c) };
}
