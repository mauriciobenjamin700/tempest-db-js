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
  | "enum"
  | "array";

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
  /** The element type of an `array` column (`text[]`, `integer[]`). */
  readonly element?: ColumnType | undefined;
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
 * escape hatch for a verbatim SQL fragment, or `{ parts }` for a parameterized
 * fragment built by the `sql.expr` tagged template (one bound parameter per gap
 * between consecutive parts).
 */
export type PortableExpression =
  | "now"
  | "current_date"
  | "current_time"
  | "uuidv4"
  | { readonly raw: string }
  | { readonly parts: readonly string[] };

/**
 * A column default. Either a constant literal value or a server-side expression
 * evaluated by the database (mirrors SQLAlchemy's `default` vs `server_default`).
 * Feeds the migration IR (`DefaultIR`).
 */
export type DefaultValue =
  | { readonly kind: "literal"; readonly value: unknown }
  | { readonly kind: "expression"; readonly expression: PortableExpression };

/**
 * Brand marking a value as a SQL expression rather than a bound parameter.
 *
 * A plain object reaching `set()`/`values()` is a mistake (it would be bound as a
 * parameter and silently written as JSON or null); an object carrying this symbol
 * is deliberate, and the dialect renders it inline instead of binding it. Mirrors
 * how `Condition` is branded, so the check is a symbol lookup, not duck typing.
 */
const EXPRESSION = Symbol.for("tempest-db-js.expression");

/**
 * A SQL expression, usable both as a column default (`.default(sql.now())`) and
 * as a write value (`.set({ attempts: sql.raw("attempts + 1") })`). The dialect
 * renders `expression` inline and binds `params` in the order of the fragment's
 * gaps.
 */
export interface SqlExpression {
  readonly [EXPRESSION]: true;
  readonly kind: "expression";
  readonly expression: PortableExpression;
  /** Parameters bound into the fragment's gaps, in order (empty for a token). */
  readonly params: readonly unknown[];
}

/** Build a branded {@link SqlExpression} from a portable token or fragment. */
function expression(
  token: PortableExpression,
  params: readonly unknown[] = [],
): SqlExpression {
  return { [EXPRESSION]: true, kind: "expression", expression: token, params };
}

/**
 * Runtime guard: is this value a branded {@link SqlExpression}?
 *
 * @param value Any value handed to `set()`, `values()` or `.default()`.
 * @returns True when the value carries the expression brand.
 */
export function isSqlExpression(value: unknown): value is SqlExpression {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[EXPRESSION] === true
  );
}

/**
 * Portable server-side expressions, à la SQLAlchemy's `func`.
 *
 * Every entry doubles as a column default and as a write value, so
 * `.default(sql.now())` and `.set({ updatedAt: sql.now() })` both work.
 */
export const sql = {
  /** Current timestamp at insert (`CURRENT_TIMESTAMP` / `now()`). */
  now: (): SqlExpression => expression("now"),
  /** Current date. */
  currentDate: (): SqlExpression => expression("current_date"),
  /** Current time. */
  currentTime: (): SqlExpression => expression("current_time"),
  /** A freshly generated UUID v4 (`gen_random_uuid()` / portable fallback). */
  uuidv4: (): SqlExpression => expression("uuidv4"),
  /**
   * Escape hatch: a verbatim SQL expression rendered as-is, with no parameters.
   *
   * The fragment is interpolated into the statement untouched, so it must never
   * carry user input — use {@link sql.expr} when a value has to be bound.
   *
   * @param fragment The SQL text (e.g. `"attempts + 1"`).
   * @returns The expression, usable as a default and as a write value.
   */
  raw: (fragment: string): SqlExpression => expression({ raw: fragment }),
  /**
   * A parameterized SQL expression, written as a tagged template. Static text is
   * SQL; every `${...}` interpolation becomes a bound parameter, so the fragment
   * is injection-safe by construction.
   *
   * Cannot be used as a column default — a `DEFAULT` clause has nowhere to bind
   * parameters; use {@link sql.raw} there.
   *
   * @param parts The static SQL segments supplied by the template tag.
   * @param values The interpolated values, bound in order.
   * @returns The expression, usable as a write value.
   *
   * @example
   * ```ts
   * update(Account).set({ balance: sql.expr`balance - ${amount}` }).where({ id });
   * // UPDATE "accounts" SET "balance" = balance - $1 WHERE "id" = $2
   * ```
   */
  expr: (parts: TemplateStringsArray, ...values: unknown[]): SqlExpression =>
    expression({ parts: Array.from(parts) }, values),
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

/** True when an expression carries bound parameters (illegal in a DDL default). */
function bindsParameters(value: DefaultValue): boolean {
  return (
    value.kind === "expression" &&
    typeof value.expression === "object" &&
    "parts" in value.expression
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
    /** An explicit database column name overriding the property name, or `null`. */
    readonly dbName: string | null = null,
  ) {}

  /** Clone this column with one facet replaced, carrying every other over. */
  private derive<F2 extends ColumnFlags>(patch: {
    flags?: F2;
    defaultValue?: DefaultValue | null;
    onUpdateValue?: DefaultValue | null;
    reference?: ForeignKeyRef | null;
    dbName?: string | null;
  }): Column<T, F2> {
    return new Column<T, F2>(
      this.type,
      (patch.flags ?? this.flags) as F2,
      patch.defaultValue !== undefined ? patch.defaultValue : this.defaultValue,
      patch.onUpdateValue !== undefined ? patch.onUpdateValue : this.onUpdateValue,
      patch.reference !== undefined ? patch.reference : this.reference,
      patch.dbName !== undefined ? patch.dbName : this.dbName,
    );
  }

  primaryKey(): Column<T, F & { primaryKey: true; hasDefault: true }> {
    return this.derive({ flags: { ...this.flags, primaryKey: true, hasDefault: true } });
  }

  notNull(): Column<T, F & { notNull: true }> {
    return this.derive({ flags: { ...this.flags, notNull: true } });
  }

  /**
   * Add a `UNIQUE` constraint to the column (mirrors SQLAlchemy's
   * `mapped_column(unique=True)`). DDL-only — does not change the inferred type.
   */
  unique(): Column<T, F & { unique: true }> {
    return this.derive({ flags: { ...this.flags, unique: true } });
  }

  /**
   * Map this property to a differently-named database column, à la SQLAlchemy's
   * `mapped_column("consumer_name")` (Django's `db_column`, Prisma's `@map`).
   *
   * The override applies everywhere the name reaches SQL — select, insert,
   * update, delete, where, order by, group by, returning, conflict targets, the
   * migration IR and the drift check — while the TypeScript row keeps the
   * property name. Use it to keep a `snake_case` schema behind a `camelCase`
   * model; {@link Model.naming} does the same for a whole table at once.
   *
   * @param dbName The real column name in the database.
   * @returns A new column bound to that name.
   * @throws Error When `dbName` is empty.
   *
   * @example
   * ```ts
   * class ApiKey extends Model {
   *   static tablename = "api_keys";
   *   consumerName = column.text().name("consumer_name").notNull();
   * }
   * ```
   */
  name(dbName: string): Column<T, F> {
    if (dbName.length === 0) {
      throw new Error("column.name() requires a non-empty database column name.");
    }
    return this.derive({ dbName });
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
    return this.derive({ reference: parseReference(ref, options) });
  }

  /**
   * Set the insert-time default: a constant value of type `T`, or a portable
   * server-side expression from {@link sql} (e.g. `sql.now()`, `sql.uuidv4()`).
   *
   * @param value The literal default, or a {@link sql} expression.
   * @returns A new column carrying the default.
   * @throws Error When given a `sql.expr` fragment — a `DEFAULT` clause has
   *   nowhere to bind parameters; use `sql.raw()` for a verbatim expression.
   */
  default(value: T | DefaultValue): Column<T, F & { hasDefault: true }> {
    const resolved: DefaultValue = isDefaultValue(value)
      ? value
      : { kind: "literal", value };
    if (bindsParameters(resolved)) {
      throw new Error(
        "sql.expr`...` binds parameters and cannot be a column default — use sql.raw() for a verbatim DEFAULT expression.",
      );
    }
    return this.derive({
      flags: { ...this.flags, hasDefault: true },
      defaultValue: resolved,
    });
  }

  /**
   * Re-apply a value whenever the row is updated (e.g. an `updated_at` column
   * with `sql.now()`). Mirrors SQLAlchemy's `onupdate`.
   *
   * @param value The literal value, or a {@link sql} expression.
   * @returns A new column carrying the on-update value.
   * @throws Error When given a `sql.expr` fragment (see {@link Column.default}).
   */
  onUpdate(value: T | DefaultValue): Column<T, F> {
    const resolved: DefaultValue = isDefaultValue(value)
      ? value
      : { kind: "literal", value };
    if (bindsParameters(resolved)) {
      throw new Error(
        "sql.expr`...` binds parameters and cannot be an onUpdate default — use sql.raw() for a verbatim expression.",
      );
    }
    return this.derive({ onUpdateValue: resolved });
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
  /**
   * A PostgreSQL array column (`text[]`, `integer[]`) → `T[]`.
   *
   * PostgreSQL only: SQLite and MySQL have no native array type, and rendering
   * one as JSON there would give the same model different semantics per dialect
   * (`@>` and `&&` work on one and not the other), so the DDL renderer throws
   * for those dialects instead of falling back silently.
   *
   * @param element The element column (its type, not its flags, is what is used).
   * @returns A column whose inferred type is an array of the element's type.
   *
   * @example
   * ```ts
   * class ApiKey extends Model {
   *   static tablename = "api_keys";
   *   scopes = column.array(column.text()).notNull().default(["send"]);
   * }
   * ```
   */
  array: <T>(element: Column<T, ColumnFlags>): Column<T[], ColumnFlags> =>
    makeColumn<T[]>("array", { element: element.type }),
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

/**
 * How property names map to database column names when a column declares no
 * explicit {@link Column.name}.
 *
 *   - `"preserve"` (default) — the column name is the property name, verbatim.
 *   - `"snake_case"` — `consumerName` becomes `consumer_name`.
 */
export type NamingStrategy = "preserve" | "snake_case";

/** Convert a `camelCase` / `PascalCase` identifier to `snake_case`. */
export function toSnakeCase(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
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
  /**
   * How to derive column names from property names (default `"preserve"`). Set
   * `"snake_case"` to keep a `snake_case` schema behind a `camelCase` model
   * without annotating every column; {@link Column.name} overrides it per column.
   */
  static naming?: NamingStrategy;
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

/** A mapping between property names and database column names. */
export type NameMap = Readonly<Record<string, string>>;

/** Memoized property → column maps (`null` when every name is the identity). */
const nameMapCache = new WeakMap<ModelClass, NameMap | null>();

/** Memoized column → property maps (`null` when every name is the identity). */
const propMapCache = new WeakMap<ModelClass, NameMap | null>();

/**
 * The property → database-column map for a model, or `null` when every column
 * keeps its property name.
 *
 * `null` is the common case and the fast path: builders and the row coercer skip
 * translation entirely, so a model that renames nothing costs nothing. The map
 * is memoized per class, like {@link columnsOf}.
 *
 * @param model The model class.
 * @returns The name map, or `null` when no column is renamed.
 * @throws Error When two properties resolve to the same column name.
 */
export function columnNamesOf(model: ModelClass): NameMap | null {
  const cached = nameMapCache.get(model);
  if (cached !== undefined) return cached;
  const strategy: NamingStrategy = model.naming ?? "preserve";
  const map: Record<string, string> = {};
  const seen = new Map<string, string>();
  let renamed = false;
  for (const [prop, col] of Object.entries(columnsOf(model))) {
    const dbName = col.dbName ?? (strategy === "snake_case" ? toSnakeCase(prop) : prop);
    const collision = seen.get(dbName);
    if (collision !== undefined) {
      throw new Error(
        `${model.tablename}: properties "${collision}" and "${prop}" both map to column "${dbName}".`,
      );
    }
    seen.set(dbName, prop);
    map[prop] = dbName;
    if (dbName !== prop) renamed = true;
  }
  const result = renamed ? (map as NameMap) : null;
  nameMapCache.set(model, result);
  return result;
}

/**
 * The database-column → property map for a model, or `null` when every column
 * keeps its property name. The inverse of {@link columnNamesOf}, used to map
 * driver rows back into property space.
 *
 * @param model The model class.
 * @returns The inverse name map, or `null` when no column is renamed.
 */
export function columnPropsOf(model: ModelClass): NameMap | null {
  const cached = propMapCache.get(model);
  if (cached !== undefined) return cached;
  const forward = columnNamesOf(model);
  let result: NameMap | null = null;
  if (forward) {
    const inverse: Record<string, string> = {};
    for (const [prop, dbName] of Object.entries(forward)) inverse[dbName] = prop;
    result = inverse as NameMap;
  }
  propMapCache.set(model, result);
  return result;
}

/** Resolve one property name to its database column name. */
export function dbColumn(names: NameMap | null | undefined, prop: string): string {
  return names?.[prop] ?? prop;
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
  naming?: NamingStrategy;
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
  type LockClause,
  type LockOptions,
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
  type OnConflictOptions,
  type OnConflictUpdateOptions,
  type Returning,
  type WritePatch,
  type WriteValues,
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
  Params,
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
