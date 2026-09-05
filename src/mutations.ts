/**
 * tempest-db-js — Phase 2: typed INSERT / UPDATE / DELETE builders.
 *
 * Like `select`, these are PURE AST + phantom types — no database access. They
 * are executed in Phase 4 via `session.execute`.
 *
 * Safety rule: UPDATE and DELETE start in an *unguarded* type state. A builder
 * only becomes executable once it has a `.where(...)` clause or an explicit
 * `.unguarded()` opt-in. Phase 4's `session.execute` will accept only guarded
 * builders, making an accidental full-table write a compile error.
 */

import {
  type CondNode,
  type Condition,
  type Expression,
  isExpression,
  toCondNode,
} from "./conditions.js";
import {
  type ColumnCodec,
  type InferInsert,
  type InferModel,
  type ModelClass,
  type NameMap,
  type SqlExpression,
  codecsOf,
  columnNamesOf,
  columnsOf,
  defaultAsWriteValue,
  isSqlExpression,
} from "./index.js";
import type { WhereInput } from "./query.js";
import { ValidationError } from "./serialize.js";

// --------------------------------------------------------------------------
// shared
// --------------------------------------------------------------------------

/** Columns to return from a mutation, or "*" for the whole row. */
export type Returning = readonly string[] | "*" | null;

/**
 * A write shape over `Row`: every column accepts its own value **or** a
 * {@link SqlExpression}, which the dialect renders inline instead of binding.
 * Optionality is preserved from `Row`, so an insert shape keeps its defaults
 * optional.
 */
export type WriteValues<Row> = {
  [K in keyof Row]: Row[K] | SqlExpression | Expression;
};

/** A partial write shape — the `SET` clause of an UPDATE or a `DO UPDATE`. */
export type WritePatch<Row> = {
  [K in keyof Row]?: Row[K] | SqlExpression | Expression;
};

/**
 * Column kinds whose stored value is legitimately an object or an array. Every
 * other kind takes a scalar, so an object reaching it is a mistake.
 */
const STRUCTURED_KINDS: ReadonlySet<string> = new Set(["json", "array", "blob"]);

/** True when a value is a scalar SQL can bind as-is. */
function isBindableScalar(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "bigint" || type === "boolean") {
    return true;
  }
  return value instanceof Date || value instanceof Uint8Array;
}

/**
 * Reject write values that SQL cannot bind meaningfully, before they reach the
 * driver.
 *
 * Without this, a stray object is bound as a parameter and the driver stringifies
 * it (or stores null), so a typo like `{ attempts: { raw: "attempts + 1" } }`
 * silently corrupts the column instead of failing. TypeScript already rejects it,
 * but JavaScript callers, an `as` cast, or data crossing a network boundary do
 * not go through the type-checker. To write an expression, use the branded
 * `sql.raw()` / `sql.expr` values.
 *
 * @param model The model the statement writes to.
 * @param values The column → value map from `set()` / `values()`.
 * @param clause The clause name, for the error message.
 * @throws ValidationError When a value is not bindable, or a key is not a column.
 */
function assertWritableValues(
  model: ModelClass,
  values: Record<string, unknown>,
  clause: "set" | "values",
): void {
  const columns = columnsOf(model);
  const issues: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const col = columns[key];
    if (!col) {
      issues.push(`${clause}: "${key}" is not a column of ${model.tablename}`);
      continue;
    }
    // A column reference (`col("c.tier")`) is a legitimate write value once
    // the statement has a second source — `UPDATE ... FROM other`.
    if (isExpression(value) || isSqlExpression(value) || isBindableScalar(value)) {
      continue;
    }
    if (typeof value === "object" && STRUCTURED_KINDS.has(col.type.kind)) continue;
    issues.push(
      `${clause}: "${key}" got ${describeValue(value)}, which cannot be bound to a ` +
        `${col.type.kind} column — use sql.raw()/sql.expr\`...\` for a SQL expression`,
    );
  }
  if (issues.length > 0) throw new ValidationError(model.tablename, issues);
}

/**
 * Convert a row's values into what the database stores, for the columns that
 * declare a custom type.
 *
 * Done here, in the builder, because this is the last place with the model in
 * hand: the dialect binds values without knowing which column they came from.
 *
 * @param model The model being written.
 * @param values The row as the caller wrote it.
 * @returns The row in stored representation.
 */
function encodeWriteValues(
  model: ModelClass,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const codecs = codecsOf(model);
  if (!codecs) return values;
  const out: Record<string, unknown> = { ...values };
  for (const [key, codec] of Object.entries(codecs)) {
    if (!(key in out)) continue;
    const value = out[key];
    // A SQL expression is not a domain value — it is rendered, not converted.
    if (isSqlExpression(value) || isExpression(value)) continue;
    out[key] = codec.toDb(value);
  }
  return out;
}

/**
 * Reject a multi-row insert whose rows disagree about a **defaulted** column.
 *
 * Every row of one INSERT shares one column list, so a key present in some rows
 * and absent in others is bound as `NULL` for the rows that omit it. For a plain
 * nullable column that is exactly what omitting it meant anyway; for a column
 * with a `DEFAULT` (a primary key included) it is not — the row would be written
 * as NULL instead of taking its default. SQLite has no `DEFAULT` keyword inside
 * `VALUES`, so there is no portable per-row escape; failing loudly is the honest
 * option.
 *
 * @param model The model being inserted into.
 * @param rows The rows of this insert.
 * @throws ValidationError When rows disagree about a column that has a default.
 */
function assertConsistentRows(
  model: ModelClass,
  rows: readonly Record<string, unknown>[],
): void {
  if (rows.length < 2) return;
  const union = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) union.add(key);
  const inconsistent = [...union].filter((key) => rows.some((row) => !(key in row)));
  if (inconsistent.length === 0) return;
  const columns = columnsOf(model);
  const defaulted = inconsistent.filter((key) => columns[key]?.flags.hasDefault);
  if (defaulted.length === 0) return;
  const named = defaulted.map((c) => `"${c}"`).join(", ");
  const verb = defaulted.length === 1 ? "has" : "have";
  throw new ValidationError(model.tablename, [
    `values: ${named} ${verb} a default but is missing from some rows of this multi-row insert — every row shares one column list, so the omitting rows would be written as NULL instead of taking the default. Give the column in every row, or insert the rows separately.`,
  ]);
}

/** A short description of a rejected value, for the validation message. */
function describeValue(value: unknown): string {
  if (typeof value === "function") return "a function";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "symbol") return "a symbol";
  return "an object";
}

// --------------------------------------------------------------------------
// INSERT
// --------------------------------------------------------------------------

/**
 * Conflict-resolution clause for an INSERT (`ON CONFLICT`). `target` is the
 * conflicting column(s) (a unique/PK constraint); `update` is `"nothing"` for
 * `DO NOTHING`, or the columns to overwrite for `DO UPDATE SET`.
 */
export interface OnConflict {
  readonly target: readonly string[];
  readonly update: Record<string, unknown> | "nothing";
  /**
   * The predicate of a **partial** unique index. PostgreSQL only matches a
   * partial index as a conflict target when `ON CONFLICT` repeats its predicate,
   * so without this an insert against `... WHERE key IS NOT NULL` is rejected
   * with "there is no unique or exclusion constraint matching the ON CONFLICT
   * specification".
   */
  readonly targetWhere?: CondNode | undefined;
  /** Extra condition restricting which conflicting rows `DO UPDATE` rewrites. */
  readonly updateWhere?: CondNode | undefined;
}

/** Options for the `ON CONFLICT` clause of {@link InsertBuilder.onConflictDoNothing}. */
export interface OnConflictOptions<Full> {
  /** The predicate of the partial unique index used as the conflict target. */
  readonly where?: WhereInput<Full> | Condition;
}

/** Options for {@link InsertBuilder.onConflictDoUpdate}. */
export interface OnConflictUpdateOptions<Full> {
  /** The predicate of the partial unique index used as the conflict target. */
  readonly indexWhere?: WhereInput<Full> | Condition;
  /** Extra condition deciding which conflicting rows are actually rewritten. */
  readonly updateWhere?: WhereInput<Full> | Condition;
}

/** Serializable AST for an INSERT. */
export interface InsertNode {
  readonly kind: "insert";
  /** Per-column codecs for custom types, by property name. */
  readonly codecs?: Readonly<Record<string, ColumnCodec>> | undefined;
  readonly table: string;
  readonly values: readonly Record<string, unknown>[];
  /**
   * A `SELECT` feeding the insert, with the target columns it fills.
   *
   * Set by {@link InsertBuilder.fromSelect}; mutually exclusive with `values`.
   */
  readonly fromSelect?:
    | { readonly columns: readonly string[]; readonly select: unknown }
    | undefined;
  readonly returning: Returning;
  /** Conflict handling (`ON CONFLICT ...`), or `undefined` for none. */
  readonly onConflict?: OnConflict;
  /** Property → column map, or `undefined` when every name is the identity. */
  readonly names?: NameMap | undefined;
}

/**
 * INSERT builder.
 *
 * @typeParam Full - the complete row type (for `returning`).
 * @typeParam Ins  - the insert shape (defaults/PK optional).
 * @typeParam Ret  - execution result: `number` (rows affected) until `returning`.
 */
export class InsertBuilder<Full, Ins, Ret = number> {
  declare readonly __row: Ret;

  constructor(
    readonly node: InsertNode,
    /** The source model, used to coerce returned rows on execution. */
    readonly source: ModelClass,
  ) {}

  private with<R>(patch: Partial<InsertNode>): InsertBuilder<Full, Ins, R> {
    return new InsertBuilder<Full, Ins, R>({ ...this.node, ...patch }, this.source);
  }

  /**
   * Provide one row or many rows to insert, typed by the insert shape.
   *
   * @param rows One row, or an array of rows.
   * @returns A builder carrying the rows.
   * @throws ValidationError When a value is not a column value the dialect can
   *   bind (see the `sql` helpers for writing an expression instead), or when the
   *   rows of a multi-row insert disagree about a column that has a default.
   */
  values(
    rows: WriteValues<Ins> | readonly WriteValues<Ins>[],
  ): InsertBuilder<Full, Ins, Ret> {
    const list = (Array.isArray(rows) ? rows : [rows]) as readonly Record<
      string,
      unknown
    >[];
    // Encode before validating: a custom type's domain value (a Money object,
    // say) is not bindable until its codec has converted it, so validating first
    // would reject exactly the values the codec exists for.
    const encoded = list.map((row) => encodeWriteValues(this.source, row));
    for (const row of encoded) assertWritableValues(this.source, row, "values");
    assertConsistentRows(this.source, encoded);
    return this.with<Ret>({ values: encoded });
  }

  /**
   * On a unique/PK conflict on `target`, do nothing (skip the row).
   *
   * @param target The conflicting column(s) — a unique or primary key.
   * @param options Pass `where` to name the predicate of a **partial** unique
   *   index, which PostgreSQL requires in order to match it as a conflict target.
   * @returns A builder carrying the conflict clause.
   *
   * @example
   * ```ts
   * insert(Outbound)
   *   .values(data)
   *   .onConflictDoNothing(["consumer", "idempotencyKey"], {
   *     where: { idempotencyKey: { isNull: false } },
   *   })
   *   .returning();
   * ```
   */
  onConflictDoNothing(
    target: readonly (keyof Full & string)[],
    options?: OnConflictOptions<Full>,
  ): InsertBuilder<Full, Ins, Ret> {
    return this.with<Ret>({
      onConflict: {
        target,
        update: "nothing",
        targetWhere: options?.where ? toCondNode(options.where as never) : undefined,
      },
    });
  }

  /**
   * On a unique/PK conflict on `target`, overwrite the given columns (upsert).
   *
   * @param target The conflicting column(s) — a unique or primary key.
   * @param set The columns to update with new values.
   * @param options `indexWhere` names the predicate of a partial unique index
   *   (the conflict target); `updateWhere` further restricts which conflicting
   *   rows are rewritten.
   * @returns A builder carrying the conflict clause.
   * @throws ValidationError When a `set` value cannot be bound.
   */
  onConflictDoUpdate(
    target: readonly (keyof Full & string)[],
    set: WritePatch<Full>,
    options?: OnConflictUpdateOptions<Full>,
  ): InsertBuilder<Full, Ins, Ret> {
    assertWritableValues(this.source, set as Record<string, unknown>, "set");
    return this.with<Ret>({
      onConflict: {
        target,
        update: set as Record<string, unknown>,
        targetWhere: options?.indexWhere
          ? toCondNode(options.indexWhere as never)
          : undefined,
        updateWhere: options?.updateWhere
          ? toCondNode(options.updateWhere as never)
          : undefined,
      },
    });
  }

  /**
   * Fill the table from another query — `INSERT INTO t (a, b) SELECT …`.
   *
   * The rows never leave the database, which is the point: archiving or copying a
   * million rows should not become a million round trips through this process.
   *
   * @param columns The target columns, in the order the query projects them.
   * @param query The query producing the rows.
   * @returns A builder ready to execute.
   * @throws Error When no target column is given.
   *
   * @example
   * ```ts
   * insert(ArchivedOrder).fromSelect(
   *   ["id", "total"],
   *   select(Order, ["id", "total"]).where({ createdAt: { lt: cutoff } }),
   * );
   * ```
   */
  fromSelect<K extends keyof Ins & string>(
    columns: readonly K[],
    query: { readonly node: unknown; readonly __row: { [P in K]: unknown } },
  ): InsertBuilder<Full, Ins, Ret> {
    if (columns.length === 0) {
      throw new Error("fromSelect() needs at least one target column.");
    }
    return this.with<Ret>({
      values: [],
      fromSelect: { columns: [...columns], select: query.node },
    });
  }

  /** Return the full inserted row(s). */
  returning(): InsertBuilder<Full, Ins, Full>;
  /** Return only the given columns of the inserted row(s). */
  returning<K extends keyof Full & string>(
    columns: readonly K[],
  ): InsertBuilder<Full, Ins, Pick<Full, K>>;
  returning(columns?: readonly string[]): InsertBuilder<Full, Ins, unknown> {
    return this.with<unknown>({ returning: columns ?? "*" });
  }
}

/** Build an INSERT into the model's table. */
export function insert<C extends ModelClass>(
  model: C,
): InsertBuilder<InferModel<C>, InferInsert<C>> {
  return new InsertBuilder(
    {
      kind: "insert",
      table: model.tablename,
      values: [],
      returning: null,
      names: columnNamesOf(model) ?? undefined,
      codecs: codecsOf(model) ?? undefined,
    },
    model,
  );
}

// --------------------------------------------------------------------------
// UPDATE
// --------------------------------------------------------------------------

/** Serializable AST for an UPDATE. */
export interface UpdateNode {
  readonly kind: "update";
  /** Per-column codecs for custom types, by property name. */
  readonly codecs?: Readonly<Record<string, ColumnCodec>> | undefined;
  readonly table: string;
  /** Extra source tables (`UPDATE ... FROM other`), by alias. */
  readonly from?: readonly { readonly table: string; readonly alias: string }[];
  readonly set: Record<string, unknown>;
  readonly where: CondNode | undefined;
  /** True once a where-clause or explicit opt-in makes the write safe. */
  readonly guarded: boolean;
  readonly returning: Returning;
  /** Property → column map, or `undefined` when every name is the identity. */
  readonly names?: NameMap | undefined;
}

/**
 * Add each column's `onUpdate` value to a patch that does not already set it.
 *
 * `.onUpdate(sql.now())` is applied here, on the write path, rather than in DDL:
 * only MySQL has a column-level `ON UPDATE`, so rendering it into the schema
 * would make the same model behave differently per database. An explicit value in
 * the patch always wins — the column's `onUpdate` is a default, not an override.
 *
 * @param model The model being updated.
 * @param values The caller's patch.
 * @returns The patch, plus every applicable `onUpdate` value.
 */
function withOnUpdateValues(
  model: ModelClass,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...values };
  for (const [name, col] of Object.entries(columnsOf(model))) {
    if (col.onUpdateValue !== null && !(name in merged)) {
      merged[name] = defaultAsWriteValue(col.onUpdateValue);
    }
  }
  return merged;
}

/**
 * UPDATE builder.
 *
 * @typeParam Full     - the complete row type.
 * @typeParam Guarded  - `true` once safe to execute (has where or opted out).
 * @typeParam Ret      - execution result type.
 */
export class UpdateBuilder<Full, Guarded extends boolean, Ret = number> {
  declare readonly __row: Ret;
  declare readonly __guarded: Guarded;

  constructor(
    readonly node: UpdateNode,
    /** The source model, used to coerce returned rows on execution. */
    readonly source: ModelClass,
  ) {}

  private with<G extends boolean, R>(
    patch: Partial<UpdateNode>,
  ): UpdateBuilder<Full, G, R> {
    return new UpdateBuilder<Full, G, R>({ ...this.node, ...patch }, this.source);
  }

  /**
   * The columns to write. Partial — only the given columns change.
   *
   * A value is bound as a parameter unless it is a {@link sql} expression, which
   * is rendered inline instead — that is how a counter is written without a
   * read-modify-write race.
   *
   * @param values The column → value map.
   * @returns A builder carrying the assignments.
   * @throws ValidationError When a value is not a column value the dialect can
   *   bind (a bare object, an array on a scalar column, a function).
   *
   * @example
   * ```ts
   * update(Outbound)
   *   .set({ attempts: sql.raw("attempts + 1"), updatedAt: sql.now() })
   *   .where({ id });
   * ```
   */
  set(values: WritePatch<Full>): UpdateBuilder<Full, Guarded, Ret> {
    const encoded = encodeWriteValues(this.source, values as Record<string, unknown>);
    assertWritableValues(this.source, encoded, "set");
    return this.with<Guarded, Ret>({
      set: withOnUpdateValues(this.source, encoded),
    });
  }

  /**
   * Read from another table while updating — `UPDATE t SET … FROM other WHERE …`.
   *
   * The join condition goes in `where`, where SQL wants it:
   * `.where({ customerId: col("c.id") })`.
   *
   * PostgreSQL and SQLite (3.33+) only. MySQL spells this as a multi-table
   * `UPDATE a JOIN b`, which is out of this project's active scope, so it throws
   * there rather than emitting something the server rejects.
   *
   * @param model The extra source.
   * @param alias The name to reference it by.
   * @returns A builder carrying the extra source.
   */
  from<C extends ModelClass>(model: C, alias: string): UpdateBuilder<Full, Guarded, Ret> {
    return this.with<Guarded, Ret>({
      from: [...(this.node.from ?? []), { table: model.tablename, alias }],
    });
  }

  /** Restrict the rows to update. Marks the builder safe to execute. */
  where(input: WhereInput<Full> | Condition): UpdateBuilder<Full, true, Ret> {
    return this.with<true, Ret>({
      where: toCondNode(input as Record<string, unknown>),
      guarded: true,
    });
  }

  /** Explicit opt-in to update EVERY row. Use deliberately. */
  unguarded(): UpdateBuilder<Full, true, Ret> {
    return this.with<true, Ret>({ guarded: true });
  }

  /** Return the full updated row(s). */
  returning(): UpdateBuilder<Full, Guarded, Full>;
  /** Return only the given columns of the updated row(s). */
  returning<K extends keyof Full & string>(
    columns: readonly K[],
  ): UpdateBuilder<Full, Guarded, Pick<Full, K>>;
  returning(columns?: readonly string[]): UpdateBuilder<Full, Guarded, unknown> {
    return this.with<Guarded, unknown>({ returning: columns ?? "*" });
  }
}

/** Build an UPDATE on the model's table. Starts unguarded. */
export function update<C extends ModelClass>(
  model: C,
): UpdateBuilder<InferModel<C>, false> {
  return new UpdateBuilder(
    {
      kind: "update",
      table: model.tablename,
      set: {},
      where: undefined,
      guarded: false,
      returning: null,
      names: columnNamesOf(model) ?? undefined,
      codecs: codecsOf(model) ?? undefined,
    },
    model,
  );
}

// --------------------------------------------------------------------------
// DELETE
// --------------------------------------------------------------------------

/** Serializable AST for a DELETE. */
export interface DeleteNode {
  readonly kind: "delete";
  /** Per-column codecs for custom types, by property name. */
  readonly codecs?: Readonly<Record<string, ColumnCodec>> | undefined;
  readonly table: string;
  /** Extra source tables (`DELETE ... USING other`), by alias. */
  readonly using?: readonly { readonly table: string; readonly alias: string }[];
  readonly where: CondNode | undefined;
  readonly guarded: boolean;
  readonly returning: Returning;
  /** Property → column map, or `undefined` when every name is the identity. */
  readonly names?: NameMap | undefined;
}

/**
 * DELETE builder. Starts unguarded — same safety rule as UPDATE.
 *
 * @typeParam Full     - the complete row type.
 * @typeParam Guarded  - `true` once safe to execute.
 * @typeParam Ret      - execution result type.
 */
export class DeleteBuilder<Full, Guarded extends boolean, Ret = number> {
  declare readonly __row: Ret;
  declare readonly __guarded: Guarded;

  constructor(
    readonly node: DeleteNode,
    /** The source model, used to coerce returned rows on execution. */
    readonly source: ModelClass,
  ) {}

  private with<G extends boolean, R>(
    patch: Partial<DeleteNode>,
  ): DeleteBuilder<Full, G, R> {
    return new DeleteBuilder<Full, G, R>({ ...this.node, ...patch }, this.source);
  }

  /**
   * Delete by matching another table — `DELETE FROM t USING other WHERE …`.
   *
   * PostgreSQL only. SQLite and MySQL have no `USING` here; there the portable
   * form is `where({ id: { in: select(Other, ["id"]).where(...).asSubquery("id") } })`,
   * and this throws rather than pretending.
   *
   * @param model The extra source.
   * @param alias The name to reference it by.
   * @returns A builder carrying the extra source.
   */
  using<C extends ModelClass>(
    model: C,
    alias: string,
  ): DeleteBuilder<Full, Guarded, Ret> {
    return this.with<Guarded, Ret>({
      using: [...(this.node.using ?? []), { table: model.tablename, alias }],
    });
  }

  /** Restrict the rows to delete. Marks the builder safe to execute. */
  where(input: WhereInput<Full> | Condition): DeleteBuilder<Full, true, Ret> {
    return this.with<true, Ret>({
      where: toCondNode(input as Record<string, unknown>),
      guarded: true,
    });
  }

  /** Explicit opt-in to delete EVERY row. Use deliberately. */
  unguarded(): DeleteBuilder<Full, true, Ret> {
    return this.with<true, Ret>({ guarded: true });
  }

  /** Return the full deleted row(s). */
  returning(): DeleteBuilder<Full, Guarded, Full>;
  /** Return only the given columns of the deleted row(s). */
  returning<K extends keyof Full & string>(
    columns: readonly K[],
  ): DeleteBuilder<Full, Guarded, Pick<Full, K>>;
  returning(columns?: readonly string[]): DeleteBuilder<Full, Guarded, unknown> {
    return this.with<Guarded, unknown>({ returning: columns ?? "*" });
  }
}

/** Build a DELETE on the model's table. Starts unguarded. */
export function del<C extends ModelClass>(model: C): DeleteBuilder<InferModel<C>, false> {
  return new DeleteBuilder(
    {
      kind: "delete",
      table: model.tablename,
      where: undefined,
      guarded: false,
      returning: null,
      names: columnNamesOf(model) ?? undefined,
      codecs: codecsOf(model) ?? undefined,
    },
    model,
  );
}
