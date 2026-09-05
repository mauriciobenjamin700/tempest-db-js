/**
 * tempest-db-js — Phase 7: typed repository + pagination.
 *
 * `BaseRepository<Model>` mirrors the `tempest-fastapi-sdk` repository: a thin,
 * fully-typed CRUD + pagination layer over a model and an async session. The
 * 404-convention is honored — `getById` throws when absent, collection methods
 * return `[]` (never a "not found" error for an empty list).
 */

import type { AsyncSession } from "./engine.js";
import {
  type Column,
  type InferInsert,
  type InferModel,
  type ModelClass,
  type WhereInput,
  and,
  columnsOf,
  decodeColumnValue,
  del,
  encodeColumnValue,
  insert,
  or,
  primaryKeyFilter,
  primaryKeysOf,
  select,
  update,
} from "./index.js";

/** Pagination request — 1-indexed page. */
export interface PaginationFilter<Row> {
  readonly page?: number;
  readonly pageSize?: number;
  readonly orderBy?: keyof Row & string;
  readonly ascending?: boolean;
  readonly filters?: WhereInput<Row>;
}

/** A page of results plus metadata (mirrors `BasePaginationSchema`). */
export interface PaginationResult<Row> {
  readonly items: Row[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
}

/**
 * Cursor-pagination request.
 *
 * Cursor paging trades random access for two things offset paging cannot give on a
 * large table: no `COUNT(*)`, and a page boundary that does not shift when rows are
 * inserted while the user is reading.
 *
 * @typeParam Row - the row type being paginated.
 */
export interface CursorPaginationFilter<Row> {
  /** Opaque cursor from the previous page. Absent/`null` asks for the first page. */
  readonly cursor?: string | null;
  /** Maximum rows to return (default 20). */
  readonly limit?: number;
  /** Column to sort by. Defaults to the first primary-key column. */
  readonly orderBy?: keyof Row & string;
  /** Sort ascending. Defaults to `false`, so the newest rows come first. */
  readonly ascending?: boolean;
  /** Domain filters, applied to every page. */
  readonly filters?: WhereInput<Row>;
}

/** One cursor-paginated page. */
export interface CursorPage<Row> {
  /** The rows of this page. */
  readonly items: Row[];
  /** Cursor for the next page, or `null` when this was the last one. */
  readonly nextCursor: string | null;
}

/** Raised when a cursor is not one this repository produced. */
export class InvalidCursor extends Error {
  constructor(reason: string) {
    super(`Invalid pagination cursor: ${reason}`);
    this.name = "InvalidCursor";
  }
}

/** Payload carried inside a cursor: the ordering keys of the last row seen. */
interface CursorPayload {
  readonly v: 1;
  readonly k: Record<string, unknown>;
}

/** Encode the ordering-key values of a row into an opaque cursor. */
function encodeCursor(
  columns: Record<string, Column<unknown>>,
  keys: readonly string[],
  row: Record<string, unknown>,
): string {
  const k: Record<string, unknown> = {};
  for (const key of keys) {
    k[key] = encodeColumnValue(columns[key] as Column<unknown>, row[key]);
  }
  const payload: CursorPayload = { v: 1, k };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Read a cursor back into native key values.
 *
 * @param columns The model's columns, for per-column decoding.
 * @param keys The ordering keys this page is using.
 * @param cursor The opaque cursor.
 * @returns The key values, coerced to their column types.
 * @throws InvalidCursor When the cursor is malformed, of another version, or was
 *   produced for a different ordering.
 */
function decodeCursor(
  columns: Record<string, Column<unknown>>,
  keys: readonly string[],
  cursor: string,
): Record<string, unknown> {
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursor("not a cursor this repository produced");
  }
  if (payload === null || typeof payload !== "object" || payload.v !== 1) {
    throw new InvalidCursor("unknown cursor version");
  }
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in payload.k)) {
      throw new InvalidCursor(
        `it does not carry ${JSON.stringify(key)} — the ordering changed between pages`,
      );
    }
    values[key] = decodeColumnValue(columns[key] as Column<unknown>, payload.k[key]);
  }
  return values;
}

/**
 * The `where` fragment for "strictly after the row this cursor points at".
 *
 * Written as the expanded comparison (`a > v OR (a = v AND b > w)`) rather than a
 * row-value comparison (`(a, b) > (v, w)`): PostgreSQL supports the tuple form,
 * SQLite's support varies by version, and the expanded form compiles the same
 * everywhere.
 *
 * @param keys The ordering keys, most significant first.
 * @param values The key values of the last row of the previous page.
 * @param ascending Whether the page is ordered ascending.
 * @returns A condition selecting rows strictly after that one.
 */
function afterCursor<Row>(
  keys: readonly string[],
  values: Record<string, unknown>,
  ascending: boolean,
): WhereInput<Row> {
  const op = ascending ? "gt" : "lt";
  const build = (index: number): WhereInput<Row> => {
    const key = keys[index] as string;
    const strict = { [key]: { [op]: values[key] } } as WhereInput<Row>;
    if (index === keys.length - 1) return strict;
    return or<Row>(
      strict,
      and<Row>({ [key]: values[key] } as WhereInput<Row>, build(index + 1)),
    ) as unknown as WhereInput<Row>;
  };
  return build(0);
}

/** Raised by single-record lookups (`getById`) when nothing matches (404). */
export class RecordNotFound extends Error {
  constructor(table: string, key: unknown) {
    super(`${table} not found for key ${JSON.stringify(key)}`);
    this.name = "RecordNotFound";
  }
}

/**
 * A fully-typed CRUD + pagination repository over a model and an async session.
 *
 * @typeParam C - the model class.
 */
export class BaseRepository<C extends ModelClass> {
  private readonly pks: string[];

  constructor(
    protected readonly model: C,
    protected readonly session: AsyncSession,
  ) {
    this.pks = primaryKeysOf(model);
  }

  /** All rows matching `filters` (or everything). Empty list when none match. */
  async list(filters?: WhereInput<InferModel<C>>): Promise<InferModel<C>[]> {
    const query = filters ? select(this.model).where(filters) : select(this.model);
    return this.session.execute(query).all();
  }

  /** The first row matching `filters`, or `null`. */
  async first(filters?: WhereInput<InferModel<C>>): Promise<InferModel<C> | null> {
    const query = filters ? select(this.model).where(filters) : select(this.model);
    return this.session.execute(query).first();
  }

  /**
   * A single row by primary key, or `null`.
   *
   * @param id The key — a bare value for a single-column key, an object
   *   (`{ orderId, lineNumber }`) for a composite one.
   * @returns The row, or `null` when nothing matches.
   * @throws Error When a scalar is given for a composite key, or the key is
   *   incomplete.
   */
  async getByIdOrNull(id: unknown): Promise<InferModel<C> | null> {
    const filter = primaryKeyFilter(this.model, id) as WhereInput<InferModel<C>>;
    return this.session.execute(select(this.model).where(filter)).first();
  }

  /**
   * A single row by primary key; throws `RecordNotFound` when absent.
   *
   * @param id The key — see {@link getByIdOrNull}.
   * @returns The row.
   * @throws RecordNotFound When no row carries that key.
   */
  async getById(id: unknown): Promise<InferModel<C>> {
    const filter = primaryKeyFilter(this.model, id);
    const row = await this.session
      .execute(select(this.model).where(filter as WhereInput<InferModel<C>>))
      .first();
    if (row === null) throw new RecordNotFound(this.model.tablename, filter);
    return row;
  }

  /** Whether any row matches `filters`. */
  async exists(filters: WhereInput<InferModel<C>>): Promise<boolean> {
    return (await this.first(filters)) !== null;
  }

  /** How many rows match `filters` (or the whole table). */
  async count(filters?: WhereInput<InferModel<C>>): Promise<number> {
    const query = filters
      ? select(this.model, [this.pks[0] as keyof InferModel<C> & string]).where(filters)
      : select(this.model, [this.pks[0] as keyof InferModel<C> & string]);
    return (await this.session.execute(query).all()).length;
  }

  /** Insert one row, returning the created row. */
  async create(data: InferInsert<C>): Promise<InferModel<C>> {
    return this.session.execute(insert(this.model).values(data).returning()).one();
  }

  /** Insert many rows, returning the created rows. */
  async createMany(data: readonly InferInsert<C>[]): Promise<InferModel<C>[]> {
    if (data.length === 0) return [];
    return this.session.execute(insert(this.model).values(data).returning()).all();
  }

  /** Update rows matching `filters`; returns the number of rows affected. */
  async update(
    filters: WhereInput<InferModel<C>>,
    set: Partial<InferModel<C>>,
  ): Promise<number> {
    return this.session
      .execute(update(this.model).set(set).where(filters))
      .rowsAffected();
  }

  /** Delete rows matching `filters`; returns the number of rows affected. */
  async delete(filters: WhereInput<InferModel<C>>): Promise<number> {
    return this.session.execute(del(this.model).where(filters)).rowsAffected();
  }

  /**
   * A page of rows plus metadata. `total` counts all matching rows.
   *
   * @param filter Page, size, ordering and filters.
   * @returns The page and pagination metadata.
   */
  async paginate(
    filter: PaginationFilter<InferModel<C>> = {},
  ): Promise<PaginationResult<InferModel<C>>> {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.max(1, filter.pageSize ?? 20);
    const where = filter.filters;

    let query = where ? select(this.model).where(where) : select(this.model);
    if (filter.orderBy) {
      query = query.orderBy(filter.orderBy, filter.ascending === false ? "desc" : "asc");
    }
    query = query.limit(pageSize).offset((page - 1) * pageSize);

    const items = await this.session.execute(query).all();
    const total = await this.count(where);
    return {
      items,
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /**
   * A cursor-paginated page: the rows after `cursor`, plus the cursor for the
   * next page.
   *
   * No `COUNT(*)` runs, and the page boundary is stable under concurrent inserts —
   * the two reasons to reach for this instead of {@link paginate} on a large table.
   * The trade-off is losing random access: there is no "page 7".
   *
   * The primary key is always appended as a tie-break, so rows sharing an
   * `orderBy` value cannot be skipped or repeated across pages.
   *
   * @param filter Cursor, page size, ordering and filters.
   * @returns The page and the next cursor (`null` on the last page).
   * @throws InvalidCursor When the cursor is malformed or was built for a
   *   different ordering.
   */
  async cursorPaginate(
    filter: CursorPaginationFilter<InferModel<C>> = {},
  ): Promise<CursorPage<InferModel<C>>> {
    const limit = Math.max(1, Math.trunc(filter.limit ?? 20));
    const ascending = filter.ascending === true;
    const columns = columnsOf(this.model);
    const primary = filter.orderBy ?? (this.pks[0] as keyof InferModel<C> & string);
    const keys = [primary as string, ...this.pks.filter((k) => k !== primary)];

    const parts: WhereInput<InferModel<C>>[] = [];
    if (filter.filters) parts.push(filter.filters);
    if (filter.cursor) {
      parts.push(
        afterCursor<InferModel<C>>(
          keys,
          decodeCursor(columns, keys, filter.cursor),
          ascending,
        ),
      );
    }

    let query =
      parts.length === 0
        ? select(this.model)
        : select(this.model).where(
            parts.length === 1
              ? (parts[0] as WhereInput<InferModel<C>>)
              : (and<InferModel<C>>(...parts) as unknown as WhereInput<InferModel<C>>),
          );
    for (const key of keys) {
      query = query.orderBy(
        key as keyof InferModel<C> & string,
        ascending ? "asc" : "desc",
      );
    }

    const rows = await this.session.execute(query.limit(limit + 1)).all();
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor(columns, keys, last as Record<string, unknown>)
          : null,
    };
  }
}
