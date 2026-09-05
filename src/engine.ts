/**
 * tempest-db-js — Phase 4b: engine, session, real execution.
 *
 * Async by default (`createEngine`), with an optional sync engine for SQLite
 * (`createSyncEngine`). The database is identified by its URL (Phase 4a's
 * `parseDatabaseUrl`); the dialect compiles the builder AST to `{ sql, params }`
 * (Phase 4a's `getDialect`); a driver runs it; rows are coerced back to native
 * types via `coerceRow` (the serialization layer).
 *
 * SQLite execution is real and tested here through Node's built-in `node:sqlite`.
 * `better-sqlite3` and `postgres` (postgres.js) are lazy-loaded peer drivers.
 */

import { createRequire } from "node:module";
import { col, fn } from "./conditions.js";
import { type BaseDialect, getDialect } from "./dialect.js";
import { type ModelClass, columnNamesOf, columnsOf } from "./index.js";
import type { JoinBuilder, JoinNode } from "./join.js";
import type { InsertBuilder, InsertNode, UpdateBuilder } from "./mutations.js";
import { type SelectBuilder, select } from "./query.js";
import { coerceRow } from "./serialize.js";
import { type Dialect, type ParsedDatabaseUrl, parseDatabaseUrl } from "./url.js";

/** A synchronous `require`, usable from both ESM and CJS builds. */
const nodeRequire = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// driver layer
// ---------------------------------------------------------------------------

/** The outcome of running one statement. */
export interface DriverResult {
  /** Returned rows (SELECT or `RETURNING`); empty otherwise. */
  readonly rows: Record<string, unknown>[];
  /** Rows affected by an INSERT/UPDATE/DELETE. */
  readonly changes: number;
}

/** A synchronous driver (SQLite). */
export interface SyncDriver {
  execute(sql: string, params: readonly unknown[]): DriverResult;
  /** Lazily iterate rows (for `.stream()`), if the driver supports it. */
  iterate?(
    sql: string,
    params: readonly unknown[],
  ): IterableIterator<Record<string, unknown>>;
  close(): void;
}

/** An asynchronous driver (PostgreSQL, or an async-wrapped SQLite). */
export interface AsyncDriver {
  execute(sql: string, params: readonly unknown[]): Promise<DriverResult>;
  /** Lazily iterate rows (for `.stream()`), if the driver supports it. */
  iterate?(
    sql: string,
    params: readonly unknown[],
  ): AsyncIterableIterator<Record<string, unknown>>;
  /**
   * Reserve a single pinned connection for the duration of a transaction.
   * Pooled drivers (PostgreSQL) MUST implement this so `BEGIN`/`COMMIT` and the
   * statements between them all run on the same connection. Single-connection
   * drivers (SQLite) may omit it — `transaction` then runs on the shared handle.
   */
  reserve?(): Promise<ReservedAsyncDriver>;
  close(): Promise<void>;
}

/** An {@link AsyncDriver} pinned to one connection, used inside a transaction. */
export interface ReservedAsyncDriver extends AsyncDriver {
  /** Return the pinned connection to the pool. */
  release(): Promise<void>;
}

/** Encode a JS value into something a SQLite driver can bind. */
function encodeSqliteParam(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return value;
  if (typeof value === "object") return JSON.stringify(value);
  return value; // number, bigint, string
}

/** SQLite driver backed by Node's built-in `node:sqlite` (zero install). */
export class NodeSqliteDriver implements SyncDriver {
  // biome-ignore lint/suspicious/noExplicitAny: node:sqlite DatabaseSync has no shipped types here.
  private readonly db: any;
  /**
   * Prepared-statement cache keyed by SQL text. tempest-db-js always
   * parameterizes, so a query shape maps to one stable SQL string — reusing the
   * compiled statement avoids re-`prepare()` on every call (the dominant cost of
   * per-row inserts and point lookups).
   */
  // biome-ignore lint/suspicious/noExplicitAny: node:sqlite StatementSync has no shipped types here.
  private readonly statements = new Map<string, any>();

  // biome-ignore lint/suspicious/noExplicitAny: accept an already-open DatabaseSync handle.
  constructor(database: any) {
    this.db = database;
  }

  /**
   * Open a `node:sqlite` database at the given path (or `:memory:`).
   *
   * @param path The database file, or `":memory:"`.
   * @param options Passed straight to `DatabaseSync` (`readOnly`, `timeout`, …).
   * @returns A driver over the open handle.
   */
  static open(
    path: string,
    options?: Readonly<Record<string, unknown>>,
  ): NodeSqliteDriver {
    // Lazy require so importing tempest-db-js never forces the built-in module to load.
    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (path: string, options?: Record<string, unknown>) => unknown;
    };
    return new NodeSqliteDriver(
      options ? new DatabaseSync(path, { ...options }) : new DatabaseSync(path),
    );
  }

  /** Return the cached prepared statement for `sql`, preparing it on first use. */
  // biome-ignore lint/suspicious/noExplicitAny: statement type is unavailable here.
  private prepare(sql: string): any {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const stmt = this.db.prepare(sql);
    this.statements.set(sql, stmt);
    return stmt;
  }

  execute(sql: string, params: readonly unknown[]): DriverResult {
    const stmt = this.prepare(sql);
    const bound = params.map(encodeSqliteParam);
    if (returnsRows(sql)) {
      return { rows: stmt.all(...bound) as Record<string, unknown>[], changes: 0 };
    }
    const info = stmt.run(...bound);
    return { rows: [], changes: Number(info.changes ?? 0) };
  }

  *iterate(
    sql: string,
    params: readonly unknown[],
  ): IterableIterator<Record<string, unknown>> {
    const stmt = this.prepare(sql);
    const bound = params.map(encodeSqliteParam);
    yield* stmt.iterate(...bound) as IterableIterator<Record<string, unknown>>;
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}

/**
 * SQLite driver backed by the `better-sqlite3` peer dependency.
 *
 * Selected with `{ driver: "better-sqlite3" }` or the URL suffix
 * `sqlite+better-sqlite3://…`; the built-in `node:sqlite` stays the default, so
 * nothing has to be installed to use SQLite. Pick this one when the service
 * already runs on better-sqlite3, or needs what it exposes and `node:sqlite`
 * does not — `pragma()`, loadable extensions, its own WAL helpers.
 *
 * Row shape matches {@link NodeSqliteDriver}: plain objects, BLOBs as `Buffer`
 * (a `Uint8Array` subclass), which is what `coerceRow` already expects.
 */
export class BetterSqliteDriver implements SyncDriver {
  // biome-ignore lint/suspicious/noExplicitAny: the peer dep's types are optional here.
  private readonly db: any;
  /** Prepared-statement cache keyed by SQL text — see {@link NodeSqliteDriver}. */
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  private readonly statements = new Map<string, any>();

  // biome-ignore lint/suspicious/noExplicitAny: accept an already-open Database handle.
  constructor(database: any) {
    this.db = database;
  }

  /**
   * Open a `better-sqlite3` database at the given path (or `":memory:"`).
   *
   * @param path The database file, or `":memory:"`.
   * @param options Passed straight to `new Database()` (`readonly`, `timeout`, …).
   * @returns A driver over the open handle.
   * @throws If `better-sqlite3` is not installed — it is an optional peer
   *   dependency, so the error names the package to install.
   */
  static open(
    path: string,
    options?: Readonly<Record<string, unknown>>,
  ): BetterSqliteDriver {
    let Database: new (path: string, options?: Record<string, unknown>) => unknown;
    try {
      const mod = nodeRequire("better-sqlite3") as
        | { default?: typeof Database }
        | typeof Database;
      Database = ((mod as { default?: typeof Database }).default ??
        mod) as typeof Database;
    } catch (cause) {
      throw new Error(
        'The "better-sqlite3" driver requires the better-sqlite3 package: npm install better-sqlite3',
        { cause },
      );
    }
    return new BetterSqliteDriver(
      options ? new Database(path, { ...options }) : new Database(path),
    );
  }

  /** Return the cached prepared statement for `sql`, preparing it on first use. */
  // biome-ignore lint/suspicious/noExplicitAny: statement type is optional here.
  private prepare(sql: string): any {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const stmt = this.db.prepare(sql);
    this.statements.set(sql, stmt);
    return stmt;
  }

  execute(sql: string, params: readonly unknown[]): DriverResult {
    const stmt = this.prepare(sql);
    const bound = params.map(encodeSqliteParam);
    // better-sqlite3 throws when all()/run() is called on the wrong statement
    // kind, and it already knows which is which — ask it instead of guessing.
    if (stmt.reader) {
      return { rows: stmt.all(...bound) as Record<string, unknown>[], changes: 0 };
    }
    const info = stmt.run(...bound);
    return { rows: [], changes: Number(info.changes ?? 0) };
  }

  *iterate(
    sql: string,
    params: readonly unknown[],
  ): IterableIterator<Record<string, unknown>> {
    const stmt = this.prepare(sql);
    const bound = params.map(encodeSqliteParam);
    yield* stmt.iterate(...bound) as IterableIterator<Record<string, unknown>>;
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}

/** True when a statement yields rows (SELECT, PRAGMA, or any `RETURNING`). */
function returnsRows(sql: string): boolean {
  return /^\s*(select|pragma)/i.test(sql) || /\breturning\b/i.test(sql);
}

// ---------------------------------------------------------------------------
// executable builders & row extraction
// ---------------------------------------------------------------------------

/* biome-ignore lint/suspicious/noExplicitAny: builder generics are irrelevant to execution dispatch. */
type AnySelect = SelectBuilder<any, any, any>;
/* biome-ignore lint/suspicious/noExplicitAny: see above. */
type AnyInsert = InsertBuilder<any, any, any>;
/* biome-ignore lint/suspicious/noExplicitAny: only the guarded flag matters. */
type GuardedUpdate = UpdateBuilder<any, true, any>;
/* biome-ignore lint/suspicious/noExplicitAny: only the guarded flag matters. */
type GuardedDelete = import("./mutations.js").DeleteBuilder<any, true, any>;
/* biome-ignore lint/suspicious/noExplicitAny: join sources are irrelevant to dispatch. */
type AnyJoin = JoinBuilder<any>;

/**
 * A builder that is safe to execute. UPDATE/DELETE are accepted only once
 * guarded (after `.where()` or `.unguarded()`) — an unguarded full-table write
 * is a compile error at the execution boundary.
 */
export type Executable = AnySelect | AnyInsert | GuardedUpdate | GuardedDelete | AnyJoin;

/** The element type a builder yields on execution. */
export type RowOf<B> = B extends { readonly __row: infer R } ? R : never;

/** Internals shared between single-table builders, read structurally at runtime. */
interface SingleBuilder {
  readonly node: Parameters<BaseDialect["compile"]>[0];
  readonly source: ModelClass;
}

/** Internals of a join builder, read structurally at runtime. */
interface JoinRunnable {
  readonly node: JoinNode;
  readonly sources: Readonly<Record<string, ModelClass>>;
}

/** Split one flat `alias.column` row into a coerced composite `{ alias: {...} }`. */
function splitJoinRow(
  node: JoinNode,
  sources: Readonly<Record<string, ModelClass>>,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const leftAliases = new Set(
    node.joins.filter((j) => j.kind === "left").map((j) => j.alias),
  );
  const out: Record<string, unknown> = {};
  for (const [alias, model] of Object.entries(sources)) {
    const sub: Record<string, unknown> = {};
    const names = columnNamesOf(model);
    let allNull = true;
    for (const colName of Object.keys(columnsOf(model))) {
      const value = raw[`${alias}.${colName}`];
      if (value !== null && value !== undefined) allNull = false;
      sub[names?.[colName] ?? colName] = value;
    }
    out[alias] = leftAliases.has(alias) && allNull ? null : coerceRow(model, sub);
  }
  return out;
}

/** Coerce one raw driver row into the builder's native row shape. */
function coerceOne(builder: unknown, raw: Record<string, unknown>): unknown {
  const node = (builder as { node: { kind: string } }).node;
  if (node.kind === "join_select") {
    const b = builder as unknown as JoinRunnable;
    return splitJoinRow(b.node, b.sources, raw);
  }
  const b = builder as unknown as SingleBuilder;
  return coerceRow(b.source, raw);
}

/** Coerce raw driver rows into the builder's native row shape. */
function mapRows(builder: unknown, raw: Record<string, unknown>[]): unknown[] {
  return raw.map((r) => coerceOne(builder, r));
}

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

/** Raised by `.one()` when the row count is not exactly one. */
export class NoResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoResultError";
  }
}

/** A short, safe preview of a bound parameter for an error message. */
function previewParam(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  const text = typeof value === "string" ? value : String(value);
  return text.length > 64 ? `${text.slice(0, 61)}...` : text;
}

/**
 * Raised when the driver rejects a statement. Wraps the original driver error
 * and attaches the offending SQL and its bound parameters, so a failure points
 * at the exact query instead of an opaque driver message.
 */
export class QueryExecutionError extends Error {
  constructor(
    /** The original error thrown by the driver. */
    override readonly cause: unknown,
    /** The SQL that failed. */
    readonly sql: string,
    /** The bound parameters, in order. */
    readonly params: readonly unknown[],
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Query failed: ${reason}\n  SQL: ${sql}\n  params: [${params
        .map(previewParam)
        .join(", ")}]`,
    );
    this.name = "QueryExecutionError";
  }
}

/**
 * A hook invoked for every statement a session runs (query logging / tracing).
 * Errors thrown by the logger are ignored so logging never breaks execution.
 */
export type QueryLogger = (event: {
  readonly sql: string;
  readonly params: readonly unknown[];
}) => void;

/**
 * What a statement did, reported **after** it ran.
 *
 * `onQuery` fires before execution, so it cannot time anything; this is the other
 * half. It fires on the failure path too, with `error` set — a slow statement that
 * then fails is exactly the one worth seeing.
 */
export interface QueryEndEvent {
  /** The statement text. */
  readonly sql: string;
  /** The bound parameters, in placeholder order. */
  readonly params: readonly unknown[];
  /** Wall-clock time the driver took, in milliseconds. */
  readonly durationMs: number;
  /** Rows returned (a SELECT or `RETURNING`), or rows affected by a write. */
  readonly rowCount: number;
  /** The driver's error, when the statement failed. */
  readonly error?: unknown;
}

/**
 * Called after every statement, with its duration.
 *
 * Errors thrown by the hook are ignored, like {@link QueryLogger}.
 */
export type QueryEndLogger = (event: QueryEndEvent) => void;

/** The per-statement hooks a session carries. */
export interface QueryHooks {
  /** Called before a statement runs. */
  readonly onQuery?: QueryLogger | undefined;
  /** Called after a statement runs, with its duration. */
  readonly onQueryEnd?: QueryEndLogger | undefined;
  /** When set, `onQueryEnd` fires only for statements at least this slow (ms). */
  readonly slowQueryMs?: number | undefined;
}

/** Invoke a query logger, swallowing any error it throws. */
function emitLog(
  hooks: QueryHooks | undefined,
  sql: string,
  params: readonly unknown[],
): void {
  const logger = hooks?.onQuery;
  if (!logger) return;
  try {
    logger({ sql, params });
  } catch {
    // logging must never break execution
  }
}

/** Read a monotonic clock, in milliseconds. */
function now(): number {
  return performance.now();
}

/**
 * Invoke the end-of-statement hook, swallowing any error it throws.
 *
 * @param hooks The session's hooks.
 * @param event What the statement did.
 */
function emitQueryEnd(hooks: QueryHooks | undefined, event: QueryEndEvent): void {
  const logger = hooks?.onQueryEnd;
  if (!logger) return;
  const threshold = hooks?.slowQueryMs;
  if (threshold !== undefined && event.durationMs < threshold) return;
  try {
    logger(event);
  } catch {
    // logging must never break execution
  }
}

/** Rows a driver result reports — returned rows, or rows affected by a write. */
function resultRowCount(result: DriverResult): number {
  return result.rows.length > 0 ? result.rows.length : result.changes;
}

function firstScalar(row: Record<string, unknown> | undefined): unknown {
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length > 0 ? row[keys[0] as string] : null;
}

/** Synchronous result view over already-fetched rows. */
export class SyncResult<Row> {
  constructor(
    private readonly rows: Row[],
    private readonly changes: number,
  ) {}

  all(): Row[] {
    return this.rows;
  }
  first(): Row | null {
    return this.rows[0] ?? null;
  }
  one(): Row {
    if (this.rows.length !== 1) {
      throw new NoResultError(`expected exactly one row, got ${this.rows.length}`);
    }
    return this.rows[0] as Row;
  }
  oneOrNull(): Row | null {
    if (this.rows.length > 1) {
      throw new NoResultError(`expected at most one row, got ${this.rows.length}`);
    }
    return this.rows[0] ?? null;
  }
  scalar(): unknown {
    return firstScalar(this.rows[0] as Record<string, unknown> | undefined);
  }
  scalars(): unknown[] {
    return this.rows.map((r) => firstScalar(r as Record<string, unknown>));
  }
  rowsAffected(): number {
    return this.changes;
  }
}

/** Asynchronous result view (terminals return Promises). */
export class AsyncResult<Row> {
  constructor(private readonly inner: Promise<SyncResult<Row>>) {}

  async all(): Promise<Row[]> {
    return (await this.inner).all();
  }
  async first(): Promise<Row | null> {
    return (await this.inner).first();
  }
  async one(): Promise<Row> {
    return (await this.inner).one();
  }
  async oneOrNull(): Promise<Row | null> {
    return (await this.inner).oneOrNull();
  }
  async scalar(): Promise<unknown> {
    return (await this.inner).scalar();
  }
  async scalars(): Promise<unknown[]> {
    return (await this.inner).scalars();
  }
  async rowsAffected(): Promise<number> {
    return (await this.inner).rowsAffected();
  }
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

let savepointCounter = 0;

/**
 * True when a builder asks for `RETURNING` on a dialect that has none, so the
 * session must insert and read the row back instead of compiling one statement.
 */
function needsInsertReadBack(
  dialect: BaseDialect,
  node: Parameters<BaseDialect["compile"]>[0],
): node is InsertNode {
  return dialect.name === "mysql" && node.kind === "insert" && node.returning !== null;
}

/** The model's single primary-key property name, for the insert read-back. */
function singlePrimaryKey(model: ModelClass): string {
  const keys = Object.entries(columnsOf(model))
    .filter(([, column]) => column.flags.primaryKey)
    .map(([name]) => name);
  if (keys.length !== 1) {
    throw new Error(
      `${model.tablename} needs exactly one primary key to read an insert back on a dialect without RETURNING; found ${keys.length}.`,
    );
  }
  return keys[0] as string;
}

/** Reject a `raw()` call whose parameters are not an array. */
function assertRawParams(params: readonly unknown[]): void {
  if (!Array.isArray(params)) {
    throw new TypeError(
      "session.raw(sql, params) takes an array of bound parameters — never interpolate values into the SQL string.",
    );
  }
}

/**
 * A transaction isolation level, in the SQL standard's names.
 *
 * The database's default is what you get without asking: `read committed` on
 * PostgreSQL and MySQL's `repeatable read`. SQLite has only `serializable`.
 */
export type IsolationLevel =
  | "read uncommitted"
  | "read committed"
  | "repeatable read"
  | "serializable";

/** Characteristics for one transaction block. */
export interface TransactionOptions {
  /**
   * The isolation level for this block.
   *
   * Raising it is how the queue and outbox patterns get their invariants: under
   * `read committed` two workers can both pass the same check before either
   * commits. Asking for a level a dialect does not implement throws.
   */
  readonly isolation?: IsolationLevel;
  /**
   * Open the block read-only, so the database itself rejects a write in it.
   * PostgreSQL and MySQL only; SQLite throws.
   */
  readonly readOnly?: boolean;
}

/**
 * Refuse transaction characteristics on a block that is only joining an outer one.
 *
 * Isolation is fixed when the transaction opens; asking for it on a nested block
 * cannot take effect, and silently ignoring the request would leave the caller
 * believing they got a guarantee they do not have.
 *
 * @param options The options passed to the nested call.
 * @throws Error When any characteristic was requested.
 */
function assertNoNestedOptions(options?: TransactionOptions): void {
  if (options?.isolation || options?.readOnly) {
    throw new Error(
      "Transaction characteristics can only be set on the outermost transaction() — a nested block joins the one already open.",
    );
  }
}

/** A synchronous unit of work (SQLite). */
export class SyncSession {
  constructor(
    private readonly driver: SyncDriver,
    private readonly dialect: BaseDialect,
    /** Optional per-statement hooks (query tracing and timing). */
    private readonly hooks?: QueryHooks,
  ) {}

  /** Open `transaction()` blocks on this session; only the outermost commits. */
  private depth = 0;

  /** Log, run, time, and error-wrap one raw statement. */
  private exec(sql: string, params: readonly unknown[]): DriverResult {
    emitLog(this.hooks, sql, params);
    const startedAt = now();
    try {
      const result = this.driver.execute(sql, params);
      emitQueryEnd(this.hooks, {
        sql,
        params,
        durationMs: now() - startedAt,
        rowCount: resultRowCount(result),
      });
      return result;
    } catch (error) {
      emitQueryEnd(this.hooks, {
        sql,
        params,
        durationMs: now() - startedAt,
        rowCount: 0,
        error,
      });
      throw new QueryExecutionError(error, sql, params);
    }
  }

  /**
   * Run a raw, parameterized SQL statement (synchronous) — the runtime counterpart of the
   * migrations' `Op.execute`.
   *
   * A query builder never covers all of SQL, and without an escape hatch a single
   * unsupported query forces a whole second database stack alongside this one. Use
   * it for what the builder cannot yet express, and keep everything else typed.
   *
   * The statement goes through the same path as a compiled one: it is logged via
   * `onQuery`, wrapped in {@link QueryExecutionError} on failure, and runs on the
   * reserved connection inside `transaction()`.
   *
   * @param sql The statement text. Placeholders only (`$1` / `?` per dialect) —
   *   never interpolate a value into this string.
   * @param params The bound parameters, in placeholder order.
   * @param options Pass `as` to coerce the returned rows with a model's column
   *   types (and its column-name mapping).
   * @returns The result view over the returned rows.
   * @throws Error When `params` is not an array — the guard against calling this
   *   with an interpolated string and no parameters by mistake.
   *
   * @example
   * ```ts
   * const claimed = await session.raw<OutboundRow>(
   *   `UPDATE outbound_messages SET status = 'sending'
   *      WHERE id = ANY($1) RETURNING *`,
   *   [ids],
   *   { as: Outbound },
   * ).all();
   * ```
   */
  raw<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
    options?: { readonly as?: ModelClass },
  ): SyncResult<Row> {
    assertRawParams(params);
    const result = this.exec(sql, params);
    const model = options?.as;
    const rows = (
      model ? result.rows.map((row) => coerceRow(model, row)) : result.rows
    ) as Row[];
    return new SyncResult<Row>(rows, result.changes);
  }

  /** Compile, run, and coerce a builder into a result. */
  execute<B extends Executable>(builder: B): SyncResult<RowOf<B>> {
    const node = (builder as unknown as { node: Parameters<BaseDialect["compile"]>[0] })
      .node;
    const { sql, params } = this.dialect.compile(node);
    const result = this.exec(sql, params);
    const rows = mapRows(builder, result.rows) as RowOf<B>[];
    return new SyncResult<RowOf<B>>(rows, result.changes);
  }

  /** Run `fn` inside a transaction: commit on success, rollback on throw. */
  /**
   * How many `transaction()` blocks are open on this session.
   *
   * The counter is what makes a service that orchestrates two repositories work:
   * both hold the same session, so an inner block **joins** the outer one instead
   * of emitting a second `BEGIN`, and only the outermost exit commits.
   */
  get transactionDepth(): number {
    return this.depth;
  }

  /** Whether a `transaction()` block is currently open on this session. */
  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /**
   * Run `fn` inside a transaction, committing on a clean exit and rolling back on
   * a throw.
   *
   * **Re-entrant:** a nested call joins the block already open on this session —
   * one `BEGIN`, one `COMMIT`, and an inner failure rolls the whole thing back.
   * To recover from an inner failure without discarding the outer work, use
   * {@link beginNested}, which is a real savepoint.
   *
   * @param fn The body; receives the session to work through.
   * @returns Whatever `fn` returned.
   */
  transaction<T>(fn: (tx: SyncSession) => T, options?: TransactionOptions): T {
    if (this.depth > 0) {
      assertNoNestedOptions(options);
      this.depth += 1;
      try {
        return fn(this);
      } finally {
        this.depth -= 1;
      }
    }
    for (const stmt of this.dialect.beginStatements(options)) this.exec(stmt, []);
    this.depth = 1;
    try {
      const out = fn(this);
      this.exec("COMMIT", []);
      return out;
    } catch (error) {
      this.exec("ROLLBACK", []);
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  /** Run `fn` inside a SAVEPOINT (nested transaction). */
  beginNested<T>(fn: (sp: SyncSession) => T): T {
    savepointCounter += 1;
    const name = `qsp_${savepointCounter}`;
    this.exec(`SAVEPOINT ${name}`, []);
    try {
      const out = fn(this);
      this.exec(`RELEASE ${name}`, []);
      return out;
    } catch (error) {
      this.exec(`ROLLBACK TO ${name}`, []);
      throw error;
    }
  }

  /**
   * Lazily iterate result rows without materializing them all. Falls back to a
   * buffered fetch when the driver has no native iteration.
   */
  *stream<B extends Executable>(builder: B): IterableIterator<RowOf<B>> {
    const node = (builder as unknown as { node: Parameters<BaseDialect["compile"]>[0] })
      .node;
    const { sql, params } = this.dialect.compile(node);
    emitLog(this.hooks, sql, params);
    if (this.driver.iterate) {
      const startedAt = now();
      let rowCount = 0;
      try {
        for (const raw of this.driver.iterate(sql, params)) {
          rowCount++;
          yield coerceOne(builder, raw) as RowOf<B>;
        }
      } catch (error) {
        emitQueryEnd(this.hooks, {
          sql,
          params,
          durationMs: now() - startedAt,
          rowCount,
          error,
        });
        throw new QueryExecutionError(error, sql, params);
      }
      emitQueryEnd(this.hooks, {
        sql,
        params,
        durationMs: now() - startedAt,
        rowCount,
      });
      return;
    }
    for (const raw of this.exec(sql, params).rows) {
      yield coerceOne(builder, raw) as RowOf<B>;
    }
  }

  close(): void {
    this.driver.close();
  }

  /** `using session = ...` closes the driver when the scope exits. */
  [Symbol.dispose](): void {
    this.close();
  }
}

/** An asynchronous unit of work. */
export class AsyncSession {
  constructor(
    private readonly driver: AsyncDriver,
    private readonly dialect: BaseDialect,
    /** Optional per-statement hooks (query tracing and timing). */
    private readonly hooks?: QueryHooks,
  ) {}

  /** Open `transaction()` blocks on this session; only the outermost commits. */
  private depth = 0;

  /** Log, run, time, and error-wrap one raw statement. */
  private async exec(sql: string, params: readonly unknown[]): Promise<DriverResult> {
    emitLog(this.hooks, sql, params);
    const startedAt = now();
    try {
      const result = await this.driver.execute(sql, params);
      emitQueryEnd(this.hooks, {
        sql,
        params,
        durationMs: now() - startedAt,
        rowCount: resultRowCount(result),
      });
      return result;
    } catch (error) {
      emitQueryEnd(this.hooks, {
        sql,
        params,
        durationMs: now() - startedAt,
        rowCount: 0,
        error,
      });
      throw new QueryExecutionError(error, sql, params);
    }
  }

  /**
   * Run a raw, parameterized SQL statement — the runtime counterpart of the
   * migrations' `Op.execute`.
   *
   * A query builder never covers all of SQL, and without an escape hatch a single
   * unsupported query forces a whole second database stack alongside this one. Use
   * it for what the builder cannot yet express, and keep everything else typed.
   *
   * The statement goes through the same path as a compiled one: it is logged via
   * `onQuery`, wrapped in {@link QueryExecutionError} on failure, and runs on the
   * reserved connection inside `transaction()`.
   *
   * @param sql The statement text. Placeholders only (`$1` / `?` per dialect) —
   *   never interpolate a value into this string.
   * @param params The bound parameters, in placeholder order.
   * @param options Pass `as` to coerce the returned rows with a model's column
   *   types (and its column-name mapping).
   * @returns The result view over the returned rows.
   * @throws Error When `params` is not an array — the guard against calling this
   *   with an interpolated string and no parameters by mistake.
   *
   * @example
   * ```ts
   * const claimed = await session.raw<OutboundRow>(
   *   `UPDATE outbound_messages SET status = 'sending'
   *      WHERE id = ANY($1) RETURNING *`,
   *   [ids],
   *   { as: Outbound },
   * ).all();
   * ```
   */
  raw<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
    options?: { readonly as?: ModelClass },
  ): AsyncResult<Row> {
    assertRawParams(params);
    const model = options?.as;
    const inner = this.exec(sql, params).then((result) => {
      const rows = (
        model ? result.rows.map((row) => coerceRow(model, row)) : result.rows
      ) as Row[];
      return new SyncResult<Row>(rows, result.changes);
    });
    return new AsyncResult<Row>(inner);
  }

  execute<B extends Executable>(builder: B): AsyncResult<RowOf<B>> {
    const node = (builder as unknown as { node: Parameters<BaseDialect["compile"]>[0] })
      .node;
    if (needsInsertReadBack(this.dialect, node)) {
      return new AsyncResult<RowOf<B>>(
        this.insertAndReadBack(builder as unknown as SingleBuilder, node),
      );
    }
    const { sql, params } = this.dialect.compile(node);
    const inner = this.exec(sql, params).then((result) => {
      const rows = mapRows(builder, result.rows) as RowOf<B>[];
      return new SyncResult<RowOf<B>>(rows, result.changes);
    });
    return new AsyncResult<RowOf<B>>(inner);
  }

  /**
   * Honor `.returning()` on a dialect without `RETURNING`, by inserting and then
   * reading the row back by key.
   *
   * Both statements must run on **one** connection, because `LAST_INSERT_ID()` is
   * per-connection: outside a transaction the pooled driver is reserved for the
   * pair; inside one, the session already holds a pinned connection (a reserved
   * driver exposes no `reserve`), so it runs there directly.
   *
   * @param builder The insert builder, for its source model.
   * @param node The insert AST, whose `returning` drives the read-back.
   * @returns The result view over the read-back row.
   * @throws Error When the insert writes more than one row — `LAST_INSERT_ID()`
   *   identifies only the first, and the rest are consecutive only under some
   *   auto-increment lock modes.
   */
  private async insertAndReadBack<Row>(
    builder: SingleBuilder,
    node: InsertNode,
  ): Promise<SyncResult<Row>> {
    if (node.values.length !== 1) {
      throw new Error(
        `${this.dialect.name} has no RETURNING, and reading back a multi-row insert is not reliable — insert one row at a time, or drop .returning().`,
      );
    }
    const model = builder.source;
    const pk = singlePrimaryKey(model);
    const supplied = (node.values[0] as Record<string, unknown>)[pk];
    const readBack = select(model).where(
      supplied === undefined || supplied === null
        ? col(pk).eq(fn.call("LAST_INSERT_ID"))
        : { [pk]: supplied },
    );
    const insertSql = this.dialect.compile({ ...node, returning: null });
    const selectSql = this.dialect.compile(
      node.returning === "*" || node.returning === null
        ? readBack.node
        : { ...readBack.node, columns: node.returning },
    );
    const run = async (driver: AsyncDriver): Promise<SyncResult<Row>> => {
      const scoped = new AsyncSession(driver, this.dialect, this.hooks);
      const written = await scoped.exec(insertSql.sql, insertSql.params);
      const read = await scoped.exec(selectSql.sql, selectSql.params);
      const rows = read.rows.map((row) => coerceRow(model, row)) as Row[];
      return new SyncResult<Row>(rows, written.changes);
    };
    if (!this.driver.reserve) return run(this.driver);
    const reserved = await this.driver.reserve();
    try {
      return await run(reserved);
    } finally {
      await reserved.release();
    }
  }

  /** Lazily iterate result rows. Uses driver streaming when available. */
  async *stream<B extends Executable>(builder: B): AsyncIterableIterator<RowOf<B>> {
    const node = (builder as unknown as { node: Parameters<BaseDialect["compile"]>[0] })
      .node;
    const { sql, params } = this.dialect.compile(node);
    emitLog(this.hooks, sql, params);
    if (this.driver.iterate) {
      const startedAt = now();
      let rowCount = 0;
      try {
        for await (const raw of this.driver.iterate(sql, params)) {
          rowCount++;
          yield coerceOne(builder, raw) as RowOf<B>;
        }
      } catch (error) {
        emitQueryEnd(this.hooks, {
          sql,
          params,
          durationMs: now() - startedAt,
          rowCount,
          error,
        });
        throw new QueryExecutionError(error, sql, params);
      }
      emitQueryEnd(this.hooks, {
        sql,
        params,
        durationMs: now() - startedAt,
        rowCount,
      });
      return;
    }
    const result = await this.exec(sql, params);
    for (const raw of result.rows) {
      yield coerceOne(builder, raw) as RowOf<B>;
    }
  }

  /**
   * How many `transaction()` blocks are open on this session.
   *
   * The counter is what makes a service that orchestrates two repositories work:
   * both hold the same session, so an inner block **joins** the outer one instead
   * of emitting a second `BEGIN`, and only the outermost exit commits.
   */
  get transactionDepth(): number {
    return this.depth;
  }

  /** Whether a `transaction()` block is currently open on this session. */
  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /**
   * Run `fn` inside a transaction, committing on a clean exit and rolling back on
   * a throw.
   *
   * **Re-entrant:** a nested call joins the block already open on this session,
   * so a service orchestrating several repositories bound to the same session
   * gets one `BEGIN` and one `COMMIT`, not two of each. An inner failure rolls the
   * whole block back; use {@link beginNested} for a savepoint that can be
   * recovered from.
   *
   * Pooled drivers (PostgreSQL) pin one connection for the block: `BEGIN`/`COMMIT`
   * and every statement between them have to run on the same connection, or
   * postgres.js rejects the raw transaction. Single-connection drivers (SQLite)
   * skip the reservation.
   *
   * @param fn The body; receives the session to work through (the pinned one, on a
   *   pooled driver).
   * @returns Whatever `fn` returned.
   */
  async transaction<T>(
    fn: (tx: AsyncSession) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    if (this.depth > 0) {
      assertNoNestedOptions(options);
      this.depth += 1;
      try {
        return await fn(this);
      } finally {
        this.depth -= 1;
      }
    }
    const begin = this.dialect.beginStatements(options);
    if (this.driver.reserve) {
      const reserved = await this.driver.reserve();
      const scoped = new AsyncSession(reserved, this.dialect, this.hooks);
      try {
        for (const stmt of begin) await scoped.exec(stmt, []);
        scoped.depth = 1;
        const out = await fn(scoped);
        await scoped.exec("COMMIT", []);
        return out;
      } catch (error) {
        await scoped.exec("ROLLBACK", []);
        throw error;
      } finally {
        scoped.depth = 0;
        await reserved.release();
      }
    }
    for (const stmt of begin) await this.exec(stmt, []);
    this.depth = 1;
    try {
      const out = await fn(this);
      await this.exec("COMMIT", []);
      return out;
    } catch (error) {
      await this.exec("ROLLBACK", []);
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  /**
   * Run `fn` inside a `SAVEPOINT` (a nested transaction that can be rolled back on
   * its own).
   *
   * This is the difference from a nested {@link transaction}: a savepoint that
   * fails discards **only** its own work, so the enclosing block can catch the
   * error and carry on. A nested `transaction()` joins the outer block, and its
   * failure takes the whole block down.
   *
   * Must run inside an open transaction — PostgreSQL rejects a savepoint outside a
   * transaction block.
   *
   * @param fn The body; receives the same session.
   * @returns Whatever `fn` returned.
   */
  async beginNested<T>(fn: (sp: AsyncSession) => Promise<T>): Promise<T> {
    savepointCounter += 1;
    const name = `qsp_${savepointCounter}`;
    await this.exec(`SAVEPOINT ${name}`, []);
    try {
      const out = await fn(this);
      await this.exec(`RELEASE ${name}`, []);
      return out;
    } catch (error) {
      await this.exec(`ROLLBACK TO ${name}`, []);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  /** `await using session = ...` closes the driver when the scope exits. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

// ---------------------------------------------------------------------------
// engines
// ---------------------------------------------------------------------------

/** Connection-pool tuning (PostgreSQL; ignored by SQLite). */
export interface PoolOptions {
  /** Max connections in the pool. */
  readonly size?: number;
  /** Close a connection after it sits idle this long (ms). */
  readonly idleTimeoutMs?: number;
  /** Give up acquiring a connection after this long (ms). */
  readonly connectTimeoutMs?: number;
  /**
   * Validate a connection before pinning it for a transaction.
   *
   * A pooled connection can die without the pool noticing — a failover, a
   * pgbouncer restart, a firewall dropping an idle socket. The damage lands on
   * whoever picks it up next, and it lands worst on a transaction: `BEGIN`
   * succeeds, a statement mid-block fails, and the block dies halfway.
   *
   * With this on, `transaction()` runs `SELECT 1` on the reserved connection
   * first and reserves another one if that fails. It costs a round trip per
   * transaction, which is why it is opt-in.
   *
   * PostgreSQL only — MySQL throws, and SQLite has no pool.
   */
  readonly prePing?: boolean;
  /**
   * Close and reopen a connection older than this (ms), regardless of activity.
   *
   * The blunt companion to {@link prePing}: it bounds how long a connection can
   * have been alive, which is what keeps a slow leak (a server-side timeout, a
   * load balancer's idle cap) from becoming a mystery error hours later.
   *
   * PostgreSQL only — MySQL throws, and SQLite has no pool.
   */
  readonly recycleMs?: number;
}

/**
 * A server-side notice (a PostgreSQL `NOTICE`). The shape is the driver's own —
 * passed through untouched rather than normalized, since what is useful in it
 * differs per database.
 */
export type NoticeLogger = (notice: Record<string, unknown>) => void;

/**
 * SQLite journal modes accepted by `PRAGMA journal_mode`.
 *
 * `"wal"` is the one worth reaching for on a server: readers stop blocking the
 * writer. It needs a real file — an in-memory database refuses it and stays on
 * `"memory"`, which this layer reports as an error rather than a silent no-op.
 */
export type SqliteJournalMode =
  | "delete"
  | "truncate"
  | "persist"
  | "memory"
  | "wal"
  | "off";

/** Durability levels accepted by `PRAGMA synchronous`. */
export type SqliteSynchronous = "off" | "normal" | "full" | "extra";

/**
 * Per-connection SQLite settings, applied right after the handle opens.
 *
 * Pragmas are **per connection**, not per database file, so they belong to the
 * engine rather than to a migration. Only `foreignKeys` has a default that
 * changes behavior; every other field is emitted only when given, so an existing
 * database keeps whatever it was configured with.
 */
export interface SqliteOptions {
  /**
   * Enforce `FOREIGN KEY` constraints. **Defaults to `true`.**
   *
   * SQLite ships with enforcement `OFF`, per connection, so a declared foreign
   * key is decorative until someone turns it on: an orphan `INSERT` is accepted
   * and `ON DELETE CASCADE` never fires. tempest-db-js turns it on, which makes
   * the same model behave the same on all three databases.
   *
   * Set it to `false` only for the case it exists for — loading a dump whose
   * insert order does not respect the graph.
   */
  readonly foreignKeys?: boolean;
  /** `PRAGMA journal_mode`. Omitted: the database keeps its current mode. */
  readonly journalMode?: SqliteJournalMode;
  /** `PRAGMA busy_timeout`, in milliseconds. How long a writer waits on a lock. */
  readonly busyTimeoutMs?: number;
  /** `PRAGMA synchronous`. Durability vs write throughput. */
  readonly synchronous?: SqliteSynchronous;
}

/** Options shared by both engine flavors. */
export interface EngineOptions {
  /**
   * Override the driver detected from the URL.
   *
   * SQLite ships two: `"node:sqlite"` (the built-in, default — nothing to
   * install) and `"better-sqlite3"` (the optional peer dependency). PostgreSQL
   * runs on `"postgres"` (postgres.js) and MySQL on `"mysql2"`; naming those is
   * a no-op today, kept so the option means the same thing everywhere.
   *
   * A name this dialect does not have throws — passing `{ driver: "sqlite3" }`
   * is a decision that would otherwise be silently ignored.
   *
   * The `+suffix` in the URL (`sqlite+better-sqlite3:///app.db`) selects the same
   * way, with one difference: a suffix naming a driver from another ecosystem
   * (`sqlite+aiosqlite`, `postgresql+asyncpg`) is ignored rather than rejected,
   * so a URL copied from a Python service still connects.
   */
  readonly driver?: string;
  /** Connection-pool tuning (PostgreSQL only). */
  readonly pool?: PoolOptions;
  /**
   * Called for every statement a session runs — SQL + bound params. Use for
   * query logging/tracing. Thrown errors are swallowed so it never breaks a query.
   */
  readonly onQuery?: QueryLogger;
  /**
   * Called for every server-side notice (`CREATE TABLE IF NOT EXISTS` on an
   * existing table, `DROP ... IF EXISTS` on a missing one, and so on).
   *
   * **Without this, notices are silenced.** postgres.js defaults to printing them
   * with `console.log`, which drops a nine-line object into the host service's
   * stdout in the middle of its structured log — on every boot, since a migration
   * runner is usually the first thing to run. Writing to the host's stdout is the
   * application's decision, not a library's, so the default is to say nothing and
   * let you route them:
   *
   * ```ts
   * createEngine(url, { onNotice: (n) => logger.debug({ pg: n }, "postgres notice") });
   * ```
   *
   * Thrown errors are swallowed, like `onQuery`.
   */
  readonly onNotice?: NoticeLogger;
  /**
   * Options passed straight to the underlying driver, applied **last** so they
   * win over everything this layer derives (`pool`, `onNotice`).
   *
   * The escape hatch for what the typed surface does not model and is not going
   * to — postgres.js `connection`/`types`/`transform`/`ssl`, mysql2's own
   * settings, `node:sqlite`'s `readOnly` — so a gap need not become a feature
   * request.
   */
  readonly driverOptions?: Readonly<Record<string, unknown>>;
  /**
   * Per-connection SQLite pragmas (`foreign_keys`, `journal_mode`, …), applied
   * as soon as the handle opens. Passing it to a PostgreSQL or MySQL engine
   * throws — the settings have no meaning there, and silently ignoring them is
   * how a durability choice gets lost.
   */
  readonly sqlite?: SqliteOptions;
  /**
   * Called **after** every statement, with how long the driver took.
   *
   * `onQuery` fires before execution, so it cannot time anything; this is the
   * other half, and it fires on the failure path too (with `error` set). Use it
   * for latency metrics, tracing spans, and finding the query dragging p99.
   *
   * Errors thrown by the hook are swallowed, like `onQuery`.
   */
  readonly onQueryEnd?: QueryEndLogger;
  /**
   * Only report statements at least this slow (milliseconds) to `onQueryEnd`.
   *
   * The cheapest slow-query log there is: set a threshold, log what crosses it.
   * Without it every statement is reported.
   */
  readonly slowQueryMs?: number;
}

/**
 * Collect the per-statement hooks out of the engine options.
 *
 * @param options The engine options, if any.
 * @returns The hook bundle a session carries, or `undefined` when none is set.
 */
function queryHooks(options?: EngineOptions): QueryHooks | undefined {
  if (!options?.onQuery && !options?.onQueryEnd) return undefined;
  return {
    onQuery: options.onQuery,
    onQueryEnd: options.onQueryEnd,
    slowQueryMs: options.slowQueryMs,
  };
}

/** Invoke a notice logger, swallowing any error it throws. */
function emitNotice(logger: NoticeLogger | undefined, notice: unknown): void {
  if (!logger) return;
  try {
    logger(notice as Record<string, unknown>);
  } catch {
    // logging must never break a connection
  }
}

/** A synchronous engine (SQLite only). */
export class SyncEngine {
  readonly dialect: Dialect = "sqlite";

  constructor(
    private readonly driver: SyncDriver,
    private readonly hooks?: QueryHooks,
  ) {}

  session(): SyncSession {
    return new SyncSession(this.driver, getDialect("sqlite"), this.hooks);
  }

  transaction<T>(fn: (tx: SyncSession) => T, options?: TransactionOptions): T {
    return this.session().transaction(fn, options);
  }

  close(): void {
    this.driver.close();
  }

  /** `using engine = createSyncEngine(...)` closes the pool when the scope exits. */
  [Symbol.dispose](): void {
    this.close();
  }
}

/** An asynchronous engine. */
export class AsyncEngine {
  constructor(
    private readonly driver: AsyncDriver,
    readonly dialect: Dialect,
    private readonly hooks?: QueryHooks,
  ) {}

  session(): AsyncSession {
    return new AsyncSession(this.driver, getDialect(this.dialect), this.hooks);
  }

  transaction<T>(
    fn: (tx: AsyncSession) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    return this.session().transaction(fn, options);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  /** `await using engine = createEngine(...)` closes the pool when the scope exits. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/**
 * Adapt a sync **or** async driver to the async interface.
 *
 * `await` normalizes both: a sync driver returns a plain value, an async one a
 * promise, and awaiting either yields the result. That is what lets the migration
 * CLI take one code path instead of branching on a difference it cannot detect
 * from the object's shape.
 *
 * @param driver Either driver flavor.
 * @returns An async driver delegating to it.
 */
export function toAsyncDriver(driver: SyncDriver | AsyncDriver): AsyncDriver {
  return {
    async execute(sql: string, params: readonly unknown[]): Promise<DriverResult> {
      return await driver.execute(sql, params);
    },
    async close(): Promise<void> {
      await driver.close();
    },
  };
}

/** Wrap a sync driver so it satisfies the async interface (SQLite async path). */
function asAsync(driver: SyncDriver): AsyncDriver {
  const syncIterate = driver.iterate?.bind(driver);
  return {
    execute: (sql, params) => Promise.resolve(driver.execute(sql, params)),
    close: () => Promise.resolve(driver.close()),
    ...(syncIterate
      ? {
          iterate: async function* (sql: string, params: readonly unknown[]) {
            yield* syncIterate(sql, params);
          },
        }
      : {}),
  };
}

/** The SQLite drivers this package can open. */
type SqliteDriverName = "node:sqlite" | "better-sqlite3";

/** Accepted spellings of each SQLite driver, lowercased. */
const SQLITE_DRIVER_ALIASES: Readonly<Record<string, SqliteDriverName>> = {
  "node:sqlite": "node:sqlite",
  "node-sqlite": "node:sqlite",
  node: "node:sqlite",
  "better-sqlite3": "better-sqlite3",
  better_sqlite3: "better-sqlite3",
  bettersqlite3: "better-sqlite3",
};

/** Accepted spellings of the one driver each server dialect runs on. */
const SERVER_DRIVER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  postgresql: ["postgres", "postgres.js", "postgresjs", "pg"],
  mysql: ["mysql", "mysql2"],
};

/**
 * Validate an explicit `options.driver` against a server dialect.
 *
 * PostgreSQL and MySQL each have exactly one driver here, so the option can only
 * confirm it. Confirming is allowed; naming something else is the error the
 * silent no-op used to hide.
 *
 * @param dialect The dialect parsed from the URL.
 * @param driver The explicit override, if any.
 * @throws If `driver` is not a spelling of that dialect's driver.
 */
function checkServerDriver(dialect: Dialect, driver: string | undefined): void {
  if (!driver) return;
  const accepted = SERVER_DRIVER_ALIASES[dialect] ?? [];
  if (accepted.includes(driver.toLowerCase())) return;
  throw new Error(
    `Unknown ${dialect} driver ${JSON.stringify(driver)}; tempest-db-js runs ${dialect} on ${JSON.stringify(accepted[0])}.`,
  );
}

/**
 * Decide which SQLite driver to open: the explicit option first, then the URL
 * suffix, then the built-in.
 *
 * @param parsed The parsed URL, for its `+suffix`.
 * @param options Engine options, for an explicit `driver`.
 * @returns The driver to open.
 * @throws If `options.driver` names a driver this package does not ship. An
 *   unrecognized URL suffix does not throw — `sqlite+aiosqlite:///app.db` comes
 *   from a Python service and means "SQLite", so it falls through to the default.
 */
function resolveSqliteDriver(
  parsed: ParsedDatabaseUrl,
  options?: EngineOptions,
): SqliteDriverName {
  const explicit = options?.driver;
  if (explicit) {
    const resolved = SQLITE_DRIVER_ALIASES[explicit.toLowerCase()];
    if (!resolved) {
      throw new Error(
        `Unknown SQLite driver ${JSON.stringify(explicit)}; supported: "node:sqlite" (built-in, default) and "better-sqlite3".`,
      );
    }
    return resolved;
  }
  const fromUrl = parsed.driver
    ? SQLITE_DRIVER_ALIASES[parsed.driver.toLowerCase()]
    : undefined;
  return fromUrl ?? "node:sqlite";
}

/** `PRAGMA synchronous` names, in the numeric order SQLite reports them back. */
const SQLITE_SYNCHRONOUS_LEVELS: readonly SqliteSynchronous[] = [
  "off",
  "normal",
  "full",
  "extra",
];

/**
 * Read the single value a query-form pragma returns.
 *
 * @param driver The open SQLite driver.
 * @param name The pragma to read.
 * @returns Its value, or `null` when the pragma reported nothing.
 */
function readPragma(driver: SyncDriver, name: string): unknown {
  const { rows } = driver.execute(`PRAGMA ${name}`, []);
  const first = rows[0];
  if (!first) return null;
  return Object.values(first)[0] ?? null;
}

/**
 * Apply the configured pragmas to a freshly opened SQLite connection.
 *
 * Every pragma is **verified by reading it back**. SQLite answers a setting it
 * cannot honor by keeping the old value and saying nothing — `journal_mode=wal`
 * on an in-memory database is the common case — so writing the pragma and moving
 * on would report success for a setting that never took.
 *
 * @param driver The open driver.
 * @param options The requested settings; `foreignKeys` defaults to `true`.
 * @param path The database path, used only to explain a refused setting.
 * @throws Error When a value is out of range, or when SQLite refused a setting.
 */
function applySqlitePragmas(
  driver: SyncDriver,
  options: SqliteOptions | undefined,
  path: string,
): void {
  const foreignKeys = options?.foreignKeys ?? true;
  driver.execute(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`, []);
  if (Number(readPragma(driver, "foreign_keys")) !== (foreignKeys ? 1 : 0)) {
    throw new Error(
      `SQLite refused PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"} — the build may lack foreign-key support.`,
    );
  }

  const journalMode = options?.journalMode;
  if (journalMode) {
    driver.execute(`PRAGMA journal_mode = ${journalMode}`, []);
    const actual = String(readPragma(driver, "journal_mode") ?? "").toLowerCase();
    if (actual !== journalMode) {
      const hint =
        journalMode === "wal" && actual === "memory"
          ? " — an in-memory database cannot use WAL."
          : ".";
      throw new Error(
        `SQLite refused PRAGMA journal_mode = ${journalMode} for ${JSON.stringify(path)} and stayed on ${JSON.stringify(actual)}${hint}`,
      );
    }
  }

  const busyTimeoutMs = options?.busyTimeoutMs;
  if (busyTimeoutMs !== undefined) {
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new Error(
        `busyTimeoutMs must be a non-negative integer, got ${JSON.stringify(busyTimeoutMs)}.`,
      );
    }
    driver.execute(`PRAGMA busy_timeout = ${busyTimeoutMs}`, []);
    if (Number(readPragma(driver, "busy_timeout")) !== busyTimeoutMs) {
      throw new Error(`SQLite refused PRAGMA busy_timeout = ${busyTimeoutMs}.`);
    }
  }

  const synchronous = options?.synchronous;
  if (synchronous) {
    driver.execute(`PRAGMA synchronous = ${synchronous}`, []);
    const actual = SQLITE_SYNCHRONOUS_LEVELS[Number(readPragma(driver, "synchronous"))];
    if (actual !== synchronous) {
      throw new Error(
        `SQLite refused PRAGMA synchronous = ${synchronous} and stayed on ${JSON.stringify(actual ?? "unknown")}.`,
      );
    }
  }
}

/**
 * Reject SQLite-only settings on a dialect that has no such thing.
 *
 * @param dialect The dialect parsed from the URL.
 * @param options The engine options.
 * @throws Error When `sqlite` options are given for a server dialect.
 */
function checkSqliteOptions(dialect: Dialect, options?: EngineOptions): void {
  if (!options?.sqlite) return;
  throw new Error(
    `The "sqlite" engine options are SQLite-only; ${dialect} has no per-connection pragmas.`,
  );
}

/** Open a SQLite sync driver from a parsed URL, passing driver options through. */
function openSqliteDriver(
  parsed: ParsedDatabaseUrl,
  options?: EngineOptions,
): SyncDriver {
  const path = parsed.database ?? ":memory:";
  const driver =
    resolveSqliteDriver(parsed, options) === "better-sqlite3"
      ? BetterSqliteDriver.open(path, options?.driverOptions)
      : NodeSqliteDriver.open(path, options?.driverOptions);
  try {
    applySqlitePragmas(driver, options?.sqlite, path);
  } catch (error) {
    driver.close();
    throw error;
  }
  return driver;
}

/**
 * Create a **synchronous** engine from a database URL. SQLite only — PostgreSQL
 * has no sane synchronous driver in Node, so a Postgres URL throws, pointing at
 * the async `createEngine`.
 *
 * @param url A SQLite URL, e.g. `"sqlite:///app.db"` or `"sqlite://:memory:"`.
 * @param options Engine options.
 * @returns A `SyncEngine`.
 */
export function createSyncEngine(url: string, options?: EngineOptions): SyncEngine {
  const parsed = parseDatabaseUrl(url);
  if (parsed.dialect !== "sqlite") {
    throw new Error(
      `createSyncEngine supports only SQLite; ${parsed.dialect} is async-only — use createEngine.`,
    );
  }
  return new SyncEngine(openSqliteDriver(parsed, options), queryHooks(options));
}

/**
 * Create an **asynchronous** engine from a database URL (the default). Works for
 * both SQLite (sync driver wrapped as async) and PostgreSQL (postgres.js,
 * lazy-loaded).
 *
 * @param url A database URL, e.g. `"postgresql://app@localhost/app"` or
 *   `"sqlite:///app.db"`.
 * @param options Engine options.
 * @returns An `AsyncEngine`.
 */
export function createEngine(url: string, options?: EngineOptions): AsyncEngine {
  const parsed = parseDatabaseUrl(url);
  if (parsed.dialect === "sqlite") {
    return new AsyncEngine(
      asAsync(openSqliteDriver(parsed, options)),
      "sqlite",
      queryHooks(options),
    );
  }
  if (parsed.dialect === "mysql") {
    checkServerDriver("mysql", options?.driver);
    checkSqliteOptions("mysql", options);
    // MySQL: mysql2 is lazy-loaded the first time a query runs.
    return new AsyncEngine(
      createMysqlDriver(parsed.raw, options),
      "mysql",
      queryHooks(options),
    );
  }
  checkServerDriver("postgresql", options?.driver);
  checkSqliteOptions("postgresql", options);
  // PostgreSQL: postgres.js is lazy-loaded the first time a query runs.
  return new AsyncEngine(
    createPostgresDriver(parsed.raw, options),
    "postgresql",
    queryHooks(options),
  );
}

/** Encode a JS value into something the MySQL driver (mysql2) can bind. */
function encodeMysqlParam(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value;
  if (typeof value === "object") return JSON.stringify(value);
  return value; // number, bigint, string
}

/** Shape a mysql2 result into our `DriverResult`. */
function toMysqlResult(rows: unknown): DriverResult {
  if (Array.isArray(rows)) {
    return { rows: rows as Record<string, unknown>[], changes: 0 };
  }
  // A ResultSetHeader (INSERT/UPDATE/DELETE): no rows, affectedRows is the count.
  const header = rows as { affectedRows?: number };
  return { rows: [], changes: header.affectedRows ?? 0 };
}

/**
 * MySQL driver backed by mysql2/promise (lazy-loaded peer dependency).
 *
 * Transactions reserve a single pooled connection via {@link AsyncDriver.reserve}
 * so `BEGIN`/`COMMIT` and the statements between them run on one connection.
 * MySQL has no `RETURNING`; the dialect throws if it is requested.
 */
function createMysqlDriver(url: string, options?: EngineOptions): AsyncDriver {
  const pool = options?.pool;
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 pool typed at call site.
  let poolHandle: any;
  const ensure = async (): Promise<void> => {
    if (poolHandle) return;
    const moduleName = "mysql2/promise";
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import of the peer dep.
    const mod = (await import(/* @vite-ignore */ moduleName)) as any;
    const opts: Record<string, unknown> = { uri: url };
    if (pool?.prePing || pool?.recycleMs !== undefined) {
      throw new Error(
        "pool.prePing and pool.recycleMs are PostgreSQL-only; mysql2 has no equivalent knob.",
      );
    }
    if (pool?.size !== undefined) opts.connectionLimit = pool.size;
    if (pool?.idleTimeoutMs !== undefined) opts.idleTimeout = pool.idleTimeoutMs;
    if (pool?.connectTimeoutMs !== undefined) opts.connectTimeout = pool.connectTimeoutMs;
    Object.assign(opts, options?.driverOptions ?? {});
    poolHandle = mod.createPool(opts);
  };
  const runOn = async (
    // biome-ignore lint/suspicious/noExplicitAny: mysql2 queryable (pool or connection).
    queryable: any,
    sql: string,
    params: readonly unknown[],
  ): Promise<DriverResult> => {
    const [rows] = await queryable.query(sql, params.map(encodeMysqlParam));
    return toMysqlResult(rows);
  };
  return {
    async execute(sql: string, params: readonly unknown[]): Promise<DriverResult> {
      await ensure();
      return runOn(poolHandle, sql, params);
    },
    async reserve(): Promise<ReservedAsyncDriver> {
      await ensure();
      // biome-ignore lint/suspicious/noExplicitAny: reserved connection from mysql2.
      const conn: any = await poolHandle.getConnection();
      return {
        execute: (sql, params) => runOn(conn, sql, params),
        async release(): Promise<void> {
          conn.release();
        },
        async close(): Promise<void> {
          conn.release();
        },
      };
    },
    async close(): Promise<void> {
      if (poolHandle) await poolHandle.end();
    },
  };
}

/** Shape a postgres.js result array into our `DriverResult`. */
function toPostgresResult(rows: unknown): DriverResult {
  const arr = rows as Record<string, unknown>[] & { count?: number };
  return { rows: Array.from(arr), changes: arr.count ?? arr.length };
}

/**
 * PostgreSQL driver backed by postgres.js (lazy-loaded peer dependency).
 *
 * Transactions reserve a single connection via {@link AsyncDriver.reserve} —
 * postgres.js pools connections, so a raw `BEGIN` on the shared client would run
 * on a different connection than the statements that follow (and is rejected with
 * `UNSAFE_TRANSACTION`). The reserved connection runs `BEGIN`/`COMMIT`/`ROLLBACK`
 * and every statement between them on one socket, then is released back.
 */
function createPostgresDriver(url: string, options?: EngineOptions): AsyncDriver {
  const pool = options?.pool;
  // biome-ignore lint/suspicious/noExplicitAny: postgres.js client typed at call site.
  let client: any;
  const ensure = async (): Promise<void> => {
    if (client) return;
    // Non-literal specifier so the optional peer dep is not type-resolved at build.
    const moduleName = "postgres";
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import of the peer dep.
    const mod = (await import(/* @vite-ignore */ moduleName)) as any;
    // Map our PoolOptions onto postgres.js's option names (seconds, not ms).
    const opts: Record<string, unknown> = {};
    if (pool?.size !== undefined) opts.max = pool.size;
    if (pool?.idleTimeoutMs !== undefined)
      opts.idle_timeout = Math.ceil(pool.idleTimeoutMs / 1000);
    if (pool?.connectTimeoutMs !== undefined) {
      opts.connect_timeout = Math.ceil(pool.connectTimeoutMs / 1000);
    }
    if (pool?.recycleMs !== undefined) {
      opts.max_lifetime = Math.ceil(pool.recycleMs / 1000);
    }
    opts.onnotice = (notice: unknown): void => emitNotice(options?.onNotice, notice);
    Object.assign(opts, options?.driverOptions ?? {});
    client = (mod.default ?? mod)(url, opts);
  };
  return {
    async execute(sql: string, params: readonly unknown[]): Promise<DriverResult> {
      await ensure();
      // postgres.js `unsafe` runs a parameterized string with positional params.
      return toPostgresResult(await client.unsafe(sql, params as unknown[]));
    },
    async reserve(): Promise<ReservedAsyncDriver> {
      await ensure();
      // biome-ignore lint/suspicious/noExplicitAny: reserved connection from postgres.js.
      let conn: any = await client.reserve();
      if (pool?.prePing) {
        try {
          await conn.unsafe("SELECT 1", []);
        } catch {
          // The connection died while it sat in the pool. Drop it and take
          // another one — the pool opens a fresh one when none is idle.
          conn.release();
          conn = await client.reserve();
          await conn.unsafe("SELECT 1", []);
        }
      }
      return {
        async execute(sql: string, params: readonly unknown[]): Promise<DriverResult> {
          return toPostgresResult(await conn.unsafe(sql, params as unknown[]));
        },
        async release(): Promise<void> {
          conn.release();
        },
        async close(): Promise<void> {
          conn.release();
        },
      };
    },
    async close(): Promise<void> {
      if (client) await client.end();
    },
  };
}
