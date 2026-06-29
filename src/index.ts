/**
 * Querium — feasibility spike for Phase 1.
 *
 * Proves the central design claim: a class-based, SQLAlchemy-style model whose
 * fields are runtime column-builders can drive full static row-type inference in
 * TypeScript, despite TS erasing types at runtime.
 *
 * This is a SPIKE, not the final API. It validates the type machinery only.
 */

/** Phantom marker carrying the static TS type a column maps to. */
declare const TYPE: unique symbol;

/** Column flags that influence the inferred row/insert shape. */
interface ColumnFlags {
  readonly primaryKey: boolean;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
}

const DEFAULT_FLAGS: ColumnFlags = {
  primaryKey: false,
  notNull: false,
  hasDefault: false,
};

/**
 * The canonical, dialect-neutral kind of a column type. Mirrors SQLAlchemy's
 * generic types (e.g. `String` → varchar, `Text` → text). Dialect renderers
 * (Phase 4/6) map each kind + meta to concrete SQL per database.
 */
export type ColumnTypeKind =
  | "smallint"
  | "integer"
  | "bigint"
  | "numeric"
  | "real"
  | "double"
  | "varchar"
  | "text"
  | "char"
  | "boolean"
  | "date"
  | "time"
  | "datetime"
  | "timestamp"
  | "blob"
  | "json"
  | "uuid"
  | "enum";

/** Parameters that refine a column type and feed the migration IR / DDL. */
export interface ColumnTypeMeta {
  /** Max length for `varchar`/`char`. */
  readonly length?: number | undefined;
  /** Total digits for `numeric`. */
  readonly precision?: number | undefined;
  /** Digits after the decimal point for `numeric`. */
  readonly scale?: number | undefined;
  /** `WITH TIME ZONE` for `timestamp`/`time`. */
  readonly withTimezone?: boolean | undefined;
  /** Allowed values for `enum`. */
  readonly values?: readonly string[] | undefined;
  /** Render as `JSONB` (PostgreSQL) instead of `JSON`. */
  readonly jsonb?: boolean | undefined;
}

/** A structured, dialect-neutral column type descriptor. */
export interface ColumnType {
  readonly kind: ColumnTypeKind;
  readonly meta: ColumnTypeMeta;
}

/**
 * A portable default expression. The token is dialect-neutral; the renderer
 * (Phase 4/6) maps it to the right SQL per database — e.g. `"now"` becomes
 * `CURRENT_TIMESTAMP` on SQLite and `now()` on PostgreSQL. Use `{ raw }` as an
 * escape hatch for a verbatim SQL fragment.
 */
export type PortableExpression =
  | "now"
  | "current_date"
  | "current_time"
  | "uuidv4"
  | { readonly raw: string };

/**
 * A column default. Either a constant literal value or a server-side expression
 * evaluated by the database (mirrors SQLAlchemy's `default` vs `server_default`).
 * Feeds the migration IR (`DefaultIR`).
 */
export type DefaultValue =
  | { readonly kind: "literal"; readonly value: unknown }
  | { readonly kind: "expression"; readonly expression: PortableExpression };

/** Portable server-side default expressions, à la SQLAlchemy's `func`. */
export const sql = {
  /** Current timestamp at insert (`CURRENT_TIMESTAMP` / `now()`). */
  now: (): DefaultValue => ({ kind: "expression", expression: "now" }),
  /** Current date. */
  currentDate: (): DefaultValue => ({ kind: "expression", expression: "current_date" }),
  /** Current time. */
  currentTime: (): DefaultValue => ({ kind: "expression", expression: "current_time" }),
  /** A freshly generated UUID v4 (`gen_random_uuid()` / portable fallback). */
  uuidv4: (): DefaultValue => ({ kind: "expression", expression: "uuidv4" }),
  /** Escape hatch: a verbatim SQL expression rendered as-is. */
  raw: (expression: string): DefaultValue => ({
    kind: "expression",
    expression: { raw: expression },
  }),
} as const;

/** Narrow a `.default()` argument to a `DefaultValue` expression/literal marker. */
function isDefaultValue(value: unknown): value is DefaultValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    ((value as { kind: unknown }).kind === "literal" ||
      (value as { kind: unknown }).kind === "expression")
  );
}

/**
 * A typed column builder. Holds runtime metadata (structured `type`, `flags`,
 * `default`, `onUpdate`) and a phantom static type `T` used purely for inference.
 */
class Column<T, F extends ColumnFlags = ColumnFlags> {
  /** Phantom: never read at runtime, only inspected by the type system. */
  declare readonly [TYPE]: T;

  constructor(
    readonly type: ColumnType,
    readonly flags: F,
    /** The default applied on insert, or `null` for none. */
    readonly defaultValue: DefaultValue | null = null,
    /** The value re-applied on update (e.g. `updated_at`), or `null`. */
    readonly onUpdateValue: DefaultValue | null = null,
  ) {}

  primaryKey(): Column<T, F & { primaryKey: true; hasDefault: true }> {
    return new Column(
      this.type,
      { ...this.flags, primaryKey: true, hasDefault: true },
      this.defaultValue,
      this.onUpdateValue,
    );
  }

  notNull(): Column<T, F & { notNull: true }> {
    return new Column(
      this.type,
      { ...this.flags, notNull: true },
      this.defaultValue,
      this.onUpdateValue,
    );
  }

  /**
   * Set the insert-time default: a constant value of type `T`, or a portable
   * server-side expression from {@link sql} (e.g. `sql.now()`, `sql.uuidv4()`).
   */
  default(value: T | DefaultValue): Column<T, F & { hasDefault: true }> {
    const resolved: DefaultValue = isDefaultValue(value)
      ? value
      : { kind: "literal", value };
    return new Column(
      this.type,
      { ...this.flags, hasDefault: true },
      resolved,
      this.onUpdateValue,
    );
  }

  /**
   * Re-apply a value whenever the row is updated (e.g. an `updated_at` column
   * with `sql.now()`). Mirrors SQLAlchemy's `onupdate`.
   */
  onUpdate(value: T | DefaultValue): Column<T, F> {
    const resolved: DefaultValue = isDefaultValue(value)
      ? value
      : { kind: "literal", value };
    return new Column(this.type, this.flags, this.defaultValue, resolved);
  }
}

/** Build a `Column` of static type `T` from a kind + optional meta. */
function makeColumn<T>(
  kind: ColumnTypeKind,
  meta: ColumnTypeMeta = {},
): Column<T, ColumnFlags> {
  return new Column<T, ColumnFlags>({ kind, meta }, DEFAULT_FLAGS);
}

/**
 * Column factory mirroring SQLAlchemy's typed column constructors. Each entry
 * pairs a distinct SQL type with the TypeScript type it maps to.
 *
 * Notable mappings:
 *   - `varchar(n)` (`VARCHAR(n)`) is distinct from `text` (`TEXT`).
 *   - `bigInteger` maps to `bigint` (not `number`) to keep 64-bit precision.
 *   - `numeric`/`decimal` map to `string` — JavaScript has no exact decimal, and
 *     stringifying preserves precision instead of losing it to a float.
 *   - `json<T>()` carries the parsed value type; `jsonb` is the PostgreSQL variant.
 *   - `enum(...)` infers a string-literal union from its values.
 */
export const column = {
  /** `SMALLINT` → `number`. */
  smallInteger: (): Column<number, ColumnFlags> => makeColumn<number>("smallint"),
  /** `INTEGER` → `number`. */
  integer: (): Column<number, ColumnFlags> => makeColumn<number>("integer"),
  /** `BIGINT` → `bigint` (64-bit precision preserved). */
  bigInteger: (): Column<bigint, ColumnFlags> => makeColumn<bigint>("bigint"),
  /** `NUMERIC(precision, scale)` → `string` (exact decimal, no float loss). */
  numeric: (precision?: number, scale?: number): Column<string, ColumnFlags> =>
    makeColumn<string>("numeric", { precision, scale }),
  /** Alias of {@link column.numeric}. */
  decimal: (precision?: number, scale?: number): Column<string, ColumnFlags> =>
    makeColumn<string>("numeric", { precision, scale }),
  /** `REAL` → `number`. */
  real: (): Column<number, ColumnFlags> => makeColumn<number>("real"),
  /** `DOUBLE PRECISION` → `number`. */
  double: (): Column<number, ColumnFlags> => makeColumn<number>("double"),
  /** `VARCHAR(length)` → `string`. Distinct from {@link column.text}. */
  varchar: (length: number): Column<string, ColumnFlags> =>
    makeColumn<string>("varchar", { length }),
  /** Alias of {@link column.varchar} (SQLAlchemy's `String`). */
  string: (length: number): Column<string, ColumnFlags> =>
    makeColumn<string>("varchar", { length }),
  /** `CHAR(length)` → `string` (fixed-width). */
  char: (length: number): Column<string, ColumnFlags> =>
    makeColumn<string>("char", { length }),
  /** `TEXT` → `string` (unbounded). Distinct from {@link column.varchar}. */
  text: (): Column<string, ColumnFlags> => makeColumn<string>("text"),
  /** `BOOLEAN` → `boolean`. */
  boolean: (): Column<boolean, ColumnFlags> => makeColumn<boolean>("boolean"),
  /** `DATE` → `Date`. */
  date: (): Column<Date, ColumnFlags> => makeColumn<Date>("date"),
  /** `TIME` → `string`. Pass `{ timezone: true }` for `WITH TIME ZONE`. */
  time: (options?: { timezone?: boolean }): Column<string, ColumnFlags> =>
    makeColumn<string>("time", { withTimezone: options?.timezone }),
  /**
   * `DATETIME`/`TIMESTAMP` → `Date` (SQLAlchemy's generic `DateTime`). Pass
   * `{ timezone: true }` for `WITH TIME ZONE`. Pair with `.default(sql.now())`
   * and `.onUpdate(sql.now())` for managed `created_at`/`updated_at` columns.
   */
  datetime: (options?: { timezone?: boolean }): Column<Date, ColumnFlags> =>
    makeColumn<Date>("datetime", { withTimezone: options?.timezone }),
  /** `TIMESTAMP` → `Date` (SQL-specific). Pass `{ timezone: true }`. */
  timestamp: (options?: { timezone?: boolean }): Column<Date, ColumnFlags> =>
    makeColumn<Date>("timestamp", { withTimezone: options?.timezone }),
  /** `BLOB`/`BYTEA` → `Uint8Array`. */
  blob: (): Column<Uint8Array, ColumnFlags> => makeColumn<Uint8Array>("blob"),
  /** `JSON` → the given parsed value type `T` (defaults to `unknown`). */
  json: <T = unknown>(): Column<T, ColumnFlags> => makeColumn<T>("json"),
  /** `JSONB` (PostgreSQL) → the given parsed value type `T`. */
  jsonb: <T = unknown>(): Column<T, ColumnFlags> =>
    makeColumn<T>("json", { jsonb: true }),
  /** `UUID` → `string`. */
  uuid: (): Column<string, ColumnFlags> => makeColumn<string>("uuid"),
  /** `ENUM(...values)` → a string-literal union of the given values. */
  enum: <const E extends string>(...values: E[]): Column<E, ColumnFlags> =>
    makeColumn<E>("enum", { values }),
} as const;

/** Base class every model extends, SQLAlchemy-declarative style. */
// biome-ignore lint/complexity/noStaticOnlyClass: declarative base users subclass; column fields live on instances.
export abstract class Model {
  static tablename: string;
}

/**
 * Reflect a model class into its column map at runtime, keyed by column name.
 *
 * Instantiates the class once and collects every field that is a `Column`. Used
 * by the serialization layer and (Phase 6) the migration schema reflector.
 *
 * @param model The model class (subclass of `Model`).
 * @returns A record of column name → `Column` instance.
 */
export function columnsOf(model: ModelClass): Record<string, Column<unknown>> {
  const instance = new (model as new () => Model)();
  const out: Record<string, Column<unknown>> = {};
  for (const [key, value] of Object.entries(instance)) {
    if (value instanceof Column) {
      out[key] = value as Column<unknown>;
    }
  }
  return out;
}

/** Pull the static type out of a Column. */
type ColType<C> = C extends Column<infer T, infer _F> ? T : never;

/** Keys of the model instance whose values are Columns. */
type ColumnKeys<M> = {
  [K in keyof M]: M[K] extends Column<unknown, ColumnFlags> ? K : never;
}[keyof M];

/** Constructor type for a Model subclass. */
type ModelClass = (new () => Model) & { tablename: string };

/** Flatten an intersection into a single object literal for clean inference. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The nullability-aware value a column contributes to a row. */
type ColValue<Col> = Col extends Column<infer T, infer F>
  ? F extends { notNull: true } | { primaryKey: true }
    ? T
    : T | null
  : never;

/** True when a column has a default (or is a PK) — i.e. optional on insert. */
type HasDefault<Col> = Col extends Column<unknown, infer F>
  ? F extends { hasDefault: true }
    ? true
    : false
  : false;

/** Keys of the model whose columns are optional on insert. */
type OptionalInsertKeys<I> = {
  [K in ColumnKeys<I>]: HasDefault<I[K]> extends true ? K : never;
}[ColumnKeys<I>];

/**
 * Infer the SELECT row shape from a model class: every column field becomes its
 * mapped static type. Columns marked notNull/primaryKey are non-nullable; others
 * are `T | null` (SQL semantics — an unconstrained column can be NULL).
 */
export type InferModel<C extends ModelClass> = {
  [K in ColumnKeys<InstanceType<C>>]: ColValue<InstanceType<C>[K]>;
};

/**
 * Infer the INSERT shape: columns with a default (or PK) are optional; the rest
 * are required. Nullability is preserved on both sides.
 */
export type InferInsert<C extends ModelClass> = Simplify<
  {
    [K in OptionalInsertKeys<InstanceType<C>>]?: ColValue<InstanceType<C>[K]>;
  } & {
    [K in Exclude<
      ColumnKeys<InstanceType<C>>,
      OptionalInsertKeys<InstanceType<C>>
    >]: ColValue<InstanceType<C>[K]>;
  }
>;

export { Column, type ColType, type ColumnFlags, type ModelClass };

export {
  and,
  type CondNode,
  type Condition,
  isCondition,
  not,
  or,
  toCondNode,
  type WhereArg,
} from "./conditions.js";

export {
  type Operator,
  type OperatorsFor,
  OPERATORS,
  type OrderTerm,
  type SelectNode,
  SelectBuilder,
  select,
  type SortDirection,
  type WhereInput,
} from "./query.js";

export {
  DeleteBuilder,
  type DeleteNode,
  del,
  InsertBuilder,
  type InsertNode,
  insert,
  type Returning,
  UpdateBuilder,
  type UpdateNode,
  update,
} from "./mutations.js";

export {
  type Dialect,
  detectDialect,
  InvalidDatabaseUrl,
  type ParsedDatabaseUrl,
  parseDatabaseUrl,
} from "./url.js";

export {
  fromDict,
  parse,
  stringify,
  toDict,
  toJSON,
  ValidationError,
} from "./serialize.js";

export {
  BaseDialect,
  type CompiledQuery,
  getDialect,
  PostgresDialect,
  type QueryNode,
  SqliteDialect,
} from "./dialect.js";

export {
  type ColRef,
  join,
  JoinBuilder,
  type JoinClause,
  type JoinNode,
  type JoinOn,
  type JoinSelection,
  type JoinWhereInput,
  type Sources,
} from "./join.js";

export {
  BaseRepository,
  type PaginationFilter,
  type PaginationResult,
  RecordNotFound,
} from "./repository.js";

export {
  type BelongsTo,
  belongsTo,
  type HasMany,
  hasMany,
  loadRelations,
  type Relation,
  type RelationValue,
  type WithRelations,
} from "./relations.js";

export {
  AsyncEngine,
  AsyncResult,
  AsyncSession,
  type AsyncDriver,
  createEngine,
  createSyncEngine,
  type DriverResult,
  type EngineOptions,
  type Executable,
  NoResultError,
  NodeSqliteDriver,
  type PoolOptions,
  type RowOf,
  type SyncDriver,
  SyncEngine,
  SyncResult,
  SyncSession,
} from "./engine.js";
