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
import { type BaseDialect, getDialect } from "./dialect.js";
import { type ModelClass, columnsOf } from "./index.js";
import type { JoinBuilder, JoinNode } from "./join.js";
import type { InsertBuilder, UpdateBuilder } from "./mutations.js";
import type { SelectBuilder } from "./query.js";
import { coerceRow } from "./serialize.js";
import { type Dialect, parseDatabaseUrl } from "./url.js";

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

  /** Open a `node:sqlite` database at the given path (or `:memory:`). */
  static open(path: string): NodeSqliteDriver {
    // Lazy require so importing tempest-db-js never forces the built-in module to load.
    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (path: string) => unknown;
    };
    return new NodeSqliteDriver(new DatabaseSync(path));
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

/** True when a statement yields rows (SELECT, PRAGMA, or any `RETURNING`). */
function returnsRows(sql: string): boolean {
  return /^\s*(select|pragma)/i.test(sql) || /\breturning\b/i.test(sql);
}

// ---------------------------------------------------------------------------
// executable builders & row extraction
// ---------------------------------------------------------------------------

/* biome-ignore lint/suspicious/noExplicitAny: builder generics are irrelevant to execution dispatch. */
type AnySelect = SelectBuilder<any, any>;
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
    let allNull = true;
    for (const colName of Object.keys(columnsOf(model))) {
      const value = raw[`${alias}.${colName}`];
      if (value !== null && value !== undefined) allNull = false;
      sub[colName] = value;
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

/** Invoke a query logger, swallowing any error it throws. */
function emitLog(
  logger: QueryLogger | undefined,
  sql: string,
  params: readonly unknown[],
): void {
  if (!logger) return;
  try {
    logger({ sql, params });
  } catch {
    // logging must never break execution
  }
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

/** A synchronous unit of work (SQLite). */
export class SyncSession {
  constructor(
    private readonly driver: SyncDriver,
    private readonly dialect: BaseDialect,
    /** Optional per-statement logger (query tracing). */
    private readonly logger?: QueryLogger,
  ) {}

  /** Log, run, and error-wrap one raw statement. */
  private exec(sql: string, params: readonly unknown[]): DriverResult {
    emitLog(this.logger, sql, params);
    try {
      return this.driver.execute(sql, params);
    } catch (error) {
      throw new QueryExecutionError(error, sql, params);
    }
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
  transaction<T>(fn: (tx: SyncSession) => T): T {
    this.exec("BEGIN", []);
    try {
      const out = fn(this);
      this.exec("COMMIT", []);
      return out;
    } catch (error) {
      this.exec("ROLLBACK", []);
      throw error;
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
    emitLog(this.logger, sql, params);
    if (this.driver.iterate) {
      try {
        for (const raw of this.driver.iterate(sql, params)) {
          yield coerceOne(builder, raw) as RowOf<B>;
        }
      } catch (error) {
        throw new QueryExecutionError(error, sql, params);
      }
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
    /** Optional per-statement logger (query tracing). */
    private readonly logger?: QueryLogger,
  ) {}

  /** Log, run, and error-wrap one raw statement. */
  private async exec(sql: string, params: readonly unknown[]): Promise<DriverResult> {
    emitLog(this.logger, sql, params);
    try {
      return await this.driver.execute(sql, params);
    } catch (error) {
      throw new QueryExecutionError(error, sql, params);
    }
  }

  execute<B extends Executable>(builder: B): AsyncResult<RowOf<B>> {
    const node = (builder as unknown as { node: Parameters<BaseDialect["compile"]>[0] })
      .node;
    const { sql, params } = this.dialect.compile(node);
    const inner = this.exec(sql, params).then((result) => {
      const rows = mapRows(builder, result.rows) as RowOf<B>[];
      return new SyncResult<RowOf<B>>(rows, result.changes);
    });
    return new AsyncResult<RowOf<B>>(inner);
  }

  /** Lazily iterate result rows. Uses driver streaming when available. */
  async *stream<B extends Executable>(builder: B): AsyncIterableIterator<RowOf<B>> {
    const node = (builder as unknown as { node: Parameters<BaseDialect["compile"]>[0] })
      .node;
    const { sql, params } = this.dialect.compile(node);
    emitLog(this.logger, sql, params);
    if (this.driver.iterate) {
      try {
        for await (const raw of this.driver.iterate(sql, params)) {
          yield coerceOne(builder, raw) as RowOf<B>;
        }
      } catch (error) {
        throw new QueryExecutionError(error, sql, params);
      }
      return;
    }
    const result = await this.exec(sql, params);
    for (const raw of result.rows) {
      yield coerceOne(builder, raw) as RowOf<B>;
    }
  }

  async transaction<T>(fn: (tx: AsyncSession) => Promise<T>): Promise<T> {
    // Pooled drivers (PostgreSQL) must pin one connection: BEGIN/COMMIT and every
    // statement between them have to run on the same connection, or postgres.js
    // rejects the raw transaction. Single-connection drivers (SQLite) skip this.
    if (this.driver.reserve) {
      const reserved = await this.driver.reserve();
      const scoped = new AsyncSession(reserved, this.dialect, this.logger);
      try {
        await scoped.exec("BEGIN", []);
        const out = await fn(scoped);
        await scoped.exec("COMMIT", []);
        return out;
      } catch (error) {
        await scoped.exec("ROLLBACK", []);
        throw error;
      } finally {
        await reserved.release();
      }
    }
    await this.exec("BEGIN", []);
    try {
      const out = await fn(this);
      await this.exec("COMMIT", []);
      return out;
    } catch (error) {
      await this.exec("ROLLBACK", []);
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
}

/** Options shared by both engine flavors. */
export interface EngineOptions {
  /** Override the driver detected from the URL (e.g. `"better-sqlite3"`). */
  readonly driver?: string;
  /** Connection-pool tuning (PostgreSQL only). */
  readonly pool?: PoolOptions;
  /**
   * Called for every statement a session runs — SQL + bound params. Use for
   * query logging/tracing. Thrown errors are swallowed so it never breaks a query.
   */
  readonly onQuery?: QueryLogger;
}

/** A synchronous engine (SQLite only). */
export class SyncEngine {
  readonly dialect: Dialect = "sqlite";

  constructor(
    private readonly driver: SyncDriver,
    private readonly logger?: QueryLogger,
  ) {}

  session(): SyncSession {
    return new SyncSession(this.driver, getDialect("sqlite"), this.logger);
  }

  transaction<T>(fn: (tx: SyncSession) => T): T {
    return this.session().transaction(fn);
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
    private readonly logger?: QueryLogger,
  ) {}

  session(): AsyncSession {
    return new AsyncSession(this.driver, getDialect(this.dialect), this.logger);
  }

  transaction<T>(fn: (tx: AsyncSession) => Promise<T>): Promise<T> {
    return this.session().transaction(fn);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  /** `await using engine = createEngine(...)` closes the pool when the scope exits. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
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

/** Open a SQLite sync driver from a parsed URL. */
function openSqliteDriver(path: string, _options?: EngineOptions): SyncDriver {
  return NodeSqliteDriver.open(path);
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
  return new SyncEngine(
    openSqliteDriver(parsed.database ?? ":memory:", options),
    options?.onQuery,
  );
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
      asAsync(openSqliteDriver(parsed.database ?? ":memory:", options)),
      "sqlite",
      options?.onQuery,
    );
  }
  if (parsed.dialect === "mysql") {
    // MySQL: mysql2 is lazy-loaded the first time a query runs.
    return new AsyncEngine(
      createMysqlDriver(parsed.raw, options?.pool),
      "mysql",
      options?.onQuery,
    );
  }
  // PostgreSQL: postgres.js is lazy-loaded the first time a query runs.
  return new AsyncEngine(
    createPostgresDriver(parsed.raw, options?.pool),
    "postgresql",
    options?.onQuery,
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
function createMysqlDriver(url: string, pool?: PoolOptions): AsyncDriver {
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 pool typed at call site.
  let poolHandle: any;
  const ensure = async (): Promise<void> => {
    if (poolHandle) return;
    const moduleName = "mysql2/promise";
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import of the peer dep.
    const mod = (await import(/* @vite-ignore */ moduleName)) as any;
    const opts: Record<string, unknown> = { uri: url };
    if (pool?.size !== undefined) opts.connectionLimit = pool.size;
    if (pool?.idleTimeoutMs !== undefined) opts.idleTimeout = pool.idleTimeoutMs;
    if (pool?.connectTimeoutMs !== undefined) opts.connectTimeout = pool.connectTimeoutMs;
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
function createPostgresDriver(url: string, pool?: PoolOptions): AsyncDriver {
  // biome-ignore lint/suspicious/noExplicitAny: postgres.js client typed at call site.
  let client: any;
  const ensure = async (): Promise<void> => {
    if (client) return;
    // Non-literal specifier so the optional peer dep is not type-resolved at build.
    const moduleName = "postgres";
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import of the peer dep.
    const mod = (await import(/* @vite-ignore */ moduleName)) as any;
    // Map our PoolOptions onto postgres.js's option names (seconds, not ms).
    const opts: Record<string, number> = {};
    if (pool?.size !== undefined) opts.max = pool.size;
    if (pool?.idleTimeoutMs !== undefined)
      opts.idle_timeout = Math.ceil(pool.idleTimeoutMs / 1000);
    if (pool?.connectTimeoutMs !== undefined) {
      opts.connect_timeout = Math.ceil(pool.connectTimeoutMs / 1000);
    }
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
      const conn: any = await client.reserve();
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
