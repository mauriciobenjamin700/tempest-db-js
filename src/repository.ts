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
  type InferInsert,
  type InferModel,
  type ModelClass,
  type WhereInput,
  del,
  insert,
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
}
