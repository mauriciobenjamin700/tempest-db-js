/**
 * tempest-db-js — a repository scoped to one tenant.
 *
 * In a shared-schema multi-tenant database every tenant's rows live in the same
 * table, told apart by a column. The danger is plain: forget one
 * `WHERE tenantId = ?` and tenant A reads — or deletes — tenant B's data. The
 * footgun is not the missing predicate, it is that **every query site** has to
 * remember it.
 *
 * This binds the tenant once, at construction, and injects the predicate into
 * every read and every write the repository performs.
 */

import type { AsyncSession } from "./engine.js";
import type { InferModel, ModelClass, WhereInput } from "./index.js";
import { and, columnsOf } from "./index.js";
import { BaseRepository } from "./repository.js";

/** How a repository is bound to one tenant. */
export interface TenantScope {
  /** The column carrying the tenant, by property name. */
  readonly column: string;
  /** The tenant's identifier. */
  readonly id: unknown;
}

/**
 * A repository whose every read and write is confined to one tenant.
 *
 * @typeParam C - the model class.
 */
export class TenantScopedRepository<C extends ModelClass> extends BaseRepository<C> {
  private readonly scope: TenantScope;

  /**
   * Bind a repository to one tenant.
   *
   * @param model The model class.
   * @param session The session to run on.
   * @param scope The tenant column and id.
   * @throws Error When the model has no such column — a scope that silently
   *   matches nothing is worse than no scope at all.
   */
  constructor(model: C, session: AsyncSession, scope: TenantScope) {
    super(model, session);
    if (!(scope.column in columnsOf(model))) {
      throw new Error(
        `${model.tablename} has no "${scope.column}" column to scope by tenant.`,
      );
    }
    this.scope = scope;
  }

  /** The tenant this repository is bound to. */
  get tenantId(): unknown {
    return this.scope.id;
  }

  /**
   * Merge the tenant predicate into every read.
   *
   * The caller's filters are **added to**, never replaced: passing another
   * tenant's id produces a contradiction that matches nothing, which is the safe
   * outcome.
   *
   * @param filters The caller's filters.
   * @returns The filters plus the tenant predicate.
   */
  protected override scopeFilters(
    filters?: WhereInput<InferModel<C>>,
  ): WhereInput<InferModel<C>> | undefined {
    const tenant = { [this.scope.column]: this.scope.id } as WhereInput<InferModel<C>>;
    if (!filters) return tenant;
    return and<InferModel<C>>(filters, tenant) as unknown as WhereInput<InferModel<C>>;
  }

  /**
   * Stamp the tenant onto every row written.
   *
   * A row that arrives carrying a **different** tenant is refused rather than
   * overwritten: silently rewriting it would turn a caller's bug into data that
   * looks deliberate.
   *
   * @param data The row being written.
   * @returns The row with the tenant column set.
   * @throws Error When the row names another tenant.
   */
  protected override scopeWrite<T extends Record<string, unknown>>(data: T): T {
    const given = data[this.scope.column];
    if (given !== undefined && given !== null && given !== this.scope.id) {
      throw new Error(
        `Refusing to write ${this.model.tablename}.${this.scope.column} = ${JSON.stringify(given)} from a repository scoped to ${JSON.stringify(this.scope.id)}.`,
      );
    }
    return { ...data, [this.scope.column]: this.scope.id };
  }
}
