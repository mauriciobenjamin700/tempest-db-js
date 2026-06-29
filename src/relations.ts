/**
 * Querium — typed relations (hasMany / belongsTo) with eager loading.
 *
 * Relations are plain descriptors that reference another model plus the local /
 * foreign key. `loadRelations` fetches the related rows in **one query per
 * relation** (no N+1), groups them, and attaches them to the base rows — with
 * the result type widened so each relation key is typed (`Row[]` for hasMany,
 * `Row | null` for belongsTo).
 */

import type { AsyncSession } from "./engine.js";
import { type InferModel, type ModelClass, type WhereInput, select } from "./index.js";

/** A one-to-many relation: each base row owns many target rows. */
export interface HasMany<C extends ModelClass> {
  readonly kind: "hasMany";
  readonly target: () => C;
  /** Column on the base row (usually its primary key). */
  readonly localKey: string;
  /** Column on the target row pointing back to the base row. */
  readonly foreignKey: string;
}

/** A many-to-one relation: each base row points to one target row. */
export interface BelongsTo<C extends ModelClass> {
  readonly kind: "belongsTo";
  readonly target: () => C;
  /** Column on the base row holding the foreign key. */
  readonly localKey: string;
  /** Column on the target row (usually its primary key). */
  readonly foreignKey: string;
}

/* biome-ignore lint/suspicious/noExplicitAny: a relation map mixes target models. */
export type Relation = HasMany<any> | BelongsTo<any>;

/** Declare a one-to-many relation. */
export function hasMany<C extends ModelClass>(
  target: () => C,
  keys: { localKey: string; foreignKey: string },
): HasMany<C> {
  return {
    kind: "hasMany",
    target,
    localKey: keys.localKey,
    foreignKey: keys.foreignKey,
  };
}

/** Declare a many-to-one relation. */
export function belongsTo<C extends ModelClass>(
  target: () => C,
  keys: { localKey: string; foreignKey: string },
): BelongsTo<C> {
  return {
    kind: "belongsTo",
    target,
    localKey: keys.localKey,
    foreignKey: keys.foreignKey,
  };
}

/** The value a relation contributes to a loaded row. */
export type RelationValue<R> = R extends HasMany<infer C>
  ? InferModel<C>[]
  : R extends BelongsTo<infer C>
    ? InferModel<C> | null
    : never;

/** A base row augmented with its loaded relations. */
export type WithRelations<Row, Spec extends Record<string, Relation>> = Row & {
  [K in keyof Spec]: RelationValue<Spec[K]>;
};

/**
 * Eager-load relations onto a set of base rows. One query per relation.
 *
 * @param session The async session to query through.
 * @param rows The already-loaded base rows.
 * @param spec A map of relation name → relation descriptor.
 * @returns The base rows, each augmented with its relation values.
 */
export async function loadRelations<
  Row extends Record<string, unknown>,
  Spec extends Record<string, Relation>,
>(session: AsyncSession, rows: Row[], spec: Spec): Promise<WithRelations<Row, Spec>[]> {
  const out = rows.map((r) => ({ ...r })) as Record<string, unknown>[];

  for (const [name, rel] of Object.entries(spec)) {
    const target = rel.target();
    const localValues = [...new Set(rows.map((r) => r[rel.localKey]))];
    const related =
      localValues.length > 0
        ? await session
            .execute(
              select(target).where({
                [rel.foreignKey]: { in: localValues },
              } as WhereInput<InferModel<typeof target>>),
            )
            .all()
        : [];

    if (rel.kind === "hasMany") {
      const grouped = new Map<unknown, Record<string, unknown>[]>();
      for (const row of related as Record<string, unknown>[]) {
        const key = row[rel.foreignKey];
        const list = grouped.get(key) ?? [];
        list.push(row);
        grouped.set(key, list);
      }
      out.forEach((r, i) => {
        r[name] = grouped.get(rows[i]?.[rel.localKey]) ?? [];
      });
    } else {
      const byKey = new Map<unknown, Record<string, unknown>>();
      for (const row of related as Record<string, unknown>[]) {
        byKey.set(row[rel.foreignKey], row);
      }
      out.forEach((r, i) => {
        r[name] = byKey.get(rows[i]?.[rel.localKey]) ?? null;
      });
    }
  }

  return out as WithRelations<Row, Spec>[];
}
