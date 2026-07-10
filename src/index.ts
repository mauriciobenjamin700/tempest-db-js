/**
 * tempest-db-js — feasibility spike for Phase 1.
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
  /**
   * A `UNIQUE` constraint on the column. Does NOT influence the inferred type —
   * it is DDL-only metadata (mirrors SQLAlchemy's `mapped_column(unique=True)`).
   */
  readonly unique: boolean;
}

const DEFAULT_FLAGS: ColumnFlags = {
  primaryKey: false,
  notNull: false,
  hasDefault: false,
  unique: false,
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
 * A referential action for a foreign key's `ON DELETE` / `ON UPDATE` clause.
 * Dialect-neutral tokens rendered uppercase at the DDL edge (mirrors
 * SQLAlchemy's `ForeignKey(ondelete=..., onupdate=...)`).
 */
export type FkAction = "cascade" | "restrict" | "set null" | "set default" | "no action";

/**
 * A resolved foreign-key reference: the target `table.column` plus optional
 * referential actions. Produced by `Column.references("table.column", ...)`.
 */
export interface ForeignKeyRef {
  readonly table: string;
  readonly column: string;
  readonly onDelete?: FkAction | undefined;
  readonly onUpdate?: FkAction | undefined;
}

/** Options for a foreign-key reference (referential actions). */
export interface ForeignKeyOptions {
  readonly onDelete?: FkAction | undefined;
  readonly onUpdate?: FkAction | undefined;
}

/** Parse a `"table.column"` reference string into a {@link ForeignKeyRef}. */
function parseReference(ref: string, options?: ForeignKeyOptions): ForeignKeyRef {
  const dot = ref.lastIndexOf(".");
  if (dot <= 0 || dot === ref.length - 1) {
    throw new Error(`Invalid foreign key reference "${ref}"; expected "table.column".`);
  }
  return {
    table: ref.slice(0, dot),
    column: ref.slice(dot + 1),
    onDelete: options?.onDelete,
    onUpdate: options?.onUpdate,
  };
}

/**
 * A typed column builder. Holds runtime metadata (structured `type`, `flags`,
 * `default`, `onUpdate`, foreign-key `reference`) and a phantom static type `T`
 * used purely for inference.
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
    /** The foreign-key reference this column points to, or `null` for none. */
    readonly reference: ForeignKeyRef | null = null,
  ) {}

  primaryKey(): Column<T, F & { primaryKey: true; hasDefault: true }> {
    return new Column(
      this.type,
      { ...this.flags, primaryKey: true, hasDefault: true },
      this.defaultValue,
      this.onUpdateValue,
      this.reference,
    );
  }

  notNull(): Column<T, F & { notNull: true }> {
    return new Column(
      this.type,
      { ...this.flags, notNull: true },
      this.defaultValue,
      this.onUpdateValue,
      this.reference,
    );
  }

  /**
   * Add a `UNIQUE` constraint to the column (mirrors SQLAlchemy's
   * `mapped_column(unique=True)`). DDL-only — does not change the inferred type.
   */
  unique(): Column<T, F & { unique: true }> {
    return new Column(
      this.type,
      { ...this.flags, unique: true },
      this.defaultValue,
      this.onUpdateValue,
      this.reference,
    );
  }

  /**
   * Declare a foreign-key reference to another table's column, à la SQLAlchemy's
   * `mapped_column(ForeignKey("table.column", ondelete=...))`. DDL-only — does
   * not change the inferred type.
   *
   * @param ref The target as `"table.column"` (e.g. `"users.id"`).
   * @param options Optional `onDelete` / `onUpdate` referential actions.
   * @returns A new column carrying the reference.
   * @throws Error When `ref` is not a valid `"table.column"` string.
   */
  references(ref: string, options?: ForeignKeyOptions): Column<T, F> {
    return new Column(
      this.type,
      this.flags,
      this.defaultValue,
      this.onUpdateValue,
      parseReference(ref, options),
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
      this.reference,
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
    return new Column(this.type, this.flags, this.defaultValue, resolved, this.reference);
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

/**
 * A table-level constraint declared via a model's `static tableArgs`. Mirrors
 * SQLAlchemy's `__table_args__` entries (`UniqueConstraint`, `ForeignKeyConstraint`).
 * Use the {@link unique} and {@link foreignKey} helpers to build these.
 */
export type TableConstraint =
  | {
      readonly kind: "unique";
      readonly name?: string | undefined;
      readonly columns: readonly string[];
    }
  | {
      readonly kind: "foreignKey";
      readonly name?: string | undefined;
      readonly columns: readonly string[];
      readonly refTable: string;
      readonly refColumns: readonly string[];
      readonly onDelete?: FkAction | undefined;
      readonly onUpdate?: FkAction | undefined;
    };

/**
 * Declare a (possibly composite) `UNIQUE` table constraint over the given
 * columns. Mirrors SQLAlchemy's `UniqueConstraint("a", "b")`.
 *
 * @param columns The column names covered by the constraint.
 * @returns A unique {@link TableConstraint}.
 * @throws Error When no columns are given.
 */
export function unique(...columns: string[]): TableConstraint {
  if (columns.length === 0) {
    throw new Error("unique() requires at least one column.");
  }
  return { kind: "unique", columns };
}

/**
 * Declare a (possibly composite) foreign-key table constraint. Mirrors
 * SQLAlchemy's `ForeignKeyConstraint([...], [...], ondelete=...)`.
 *
 * @param columns The local column names.
 * @param refTable The referenced table name.
 * @param refColumns The referenced column names (same length as `columns`).
 * @param options Optional constraint `name` and referential actions.
 * @returns A foreign-key {@link TableConstraint}.
 * @throws Error When the column arrays are empty or mismatched in length.
 */
export function foreignKey(
  columns: string[],
  refTable: string,
  refColumns: string[],
  options?: { name?: string; onDelete?: FkAction; onUpdate?: FkAction },
): TableConstraint {
  if (columns.length === 0 || columns.length !== refColumns.length) {
    throw new Error(
      "foreignKey() requires matching, non-empty local and referenced column lists.",
    );
  }
  return {
    kind: "foreignKey",
    name: options?.name,
    columns,
    refTable,
    refColumns,
    onDelete: options?.onDelete,
    onUpdate: options?.onUpdate,
  };
}

/** Base class every model extends, SQLAlchemy-declarative style. */
// biome-ignore lint/complexity/noStaticOnlyClass: declarative base users subclass; column fields live on instances.
export abstract class Model {
  static tablename: string;
  /**
   * Optional table-level constraints (composite unique / foreign keys), returned
   * by a thunk so forward references resolve lazily. Mirrors SQLAlchemy's
   * `__table_args__`.
   */
  static tableArgs?: () => readonly TableConstraint[];
}

/** Memoized column maps, keyed by model class (identity is stable per class). */
const columnsCache = new WeakMap<ModelClass, Record<string, Column<unknown>>>();

/**
 * Reflect a model class into its column map at runtime, keyed by column name.
 *
 * Instantiates the class once and collects every field that is a `Column`. Used
 * by the serialization layer and (Phase 6) the migration schema reflector.
 *
 * The result is **memoized per class** — a model's columns never change at
 * runtime, and this is called once per row on hot read paths (coercion, joins),
 * so re-instantiating the class every time would dominate large result sets.
 *
 * @param model The model class (subclass of `Model`).
 * @returns A record of column name → `Column` instance (do not mutate).
 */
export function columnsOf(model: ModelClass): Record<string, Column<unknown>> {
  const cached = columnsCache.get(model);
  if (cached) return cached;
  const instance = new (model as new () => Model)();
  const out: Record<string, Column<unknown>> = {};
  for (const [key, value] of Object.entries(instance)) {
    if (value instanceof Column) {
      out[key] = value as Column<unknown>;
    }
  }
  columnsCache.set(model, out);
  return out;
}

/** Pull the static type out of a Column. */
type ColType<C> = C extends Column<infer T, infer _F> ? T : never;

/** Keys of the model instance whose values are Columns. */
type ColumnKeys<M> = {
  [K in keyof M]: M[K] extends Column<unknown, ColumnFlags> ? K : never;
}[keyof M];

/** Constructor type for a Model subclass. */
type ModelClass = (new () => Model) & {
  tablename: string;
  tableArgs?: () => readonly TableConstraint[];
};

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
  Agg,
  type AggregateTerm,
  avg,
  count,
  max,
  min,
  type Operator,
  type OperatorsFor,
  OPERATORS,
  type OrderTerm,
  type SelectNode,
  SelectBuilder,
  select,
  type SortDirection,
  sum,
  type WhereInput,
} from "./query.js";

export {
  DeleteBuilder,
  type DeleteNode,
  del,
  InsertBuilder,
  type InsertNode,
  insert,
  type OnConflict,
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
  MysqlDialect,
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
  ActiveRecord,
  type ActiveRecordManager,
  activeRecord,
} from "./active-record.js";

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
  QueryExecutionError,
  type QueryLogger,
  type ReservedAsyncDriver,
  type RowOf,
  type SyncDriver,
  SyncEngine,
  SyncResult,
  SyncSession,
} from "./engine.js";
