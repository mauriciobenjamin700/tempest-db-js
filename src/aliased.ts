/**
 * tempest-db-js — table aliases outside the join builder.
 *
 * `join(Model, "a")` has always taken an alias, so a self-join works there. A
 * plain `select()` had no way to name its table, which is what a correlated
 * subquery over the **same** table needs: without an alias, the inner and outer
 * `users` are the same name, and the correlation cannot be written at all.
 */

import type { ModelClass, NamingStrategy, TableConstraint } from "./index.js";

/**
 * The same model, reading from an alias.
 *
 * The result is a real model class — same columns, same naming strategy, same
 * codecs — whose `tablename` is the alias. Everything that already takes a model
 * takes this: `select`, `join`, `col("alias.column")`, row coercion.
 *
 * Table constraints are **not** carried over: an alias is a way to read a table,
 * not a second declaration of it, and reflecting it into a migration would try to
 * create a table named after the alias.
 *
 * @param model The model to alias.
 * @param alias The name to read it under.
 * @returns A model class bound to the alias.
 *
 * @example
 * ```ts
 * const sub = aliased(User, "sub");
 * select(User).where(
 *   exists(select(sub).where({ managerId: col("users.id") })),
 * );
 * // WHERE EXISTS (SELECT * FROM "users" AS "sub" WHERE "managerId" = "users"."id")
 * ```
 */
export function aliased<C extends ModelClass>(model: C, alias: string): C {
  const aliasedModel = class extends (model as unknown as new () => object) {};
  Object.defineProperty(aliasedModel, "tablename", { value: alias, writable: true });
  Object.defineProperty(aliasedModel, "naming", {
    value: (model as { naming?: NamingStrategy }).naming,
    writable: true,
  });
  Object.defineProperty(aliasedModel, "tableArgs", {
    value: undefined as (() => readonly TableConstraint[]) | undefined,
    writable: true,
  });
  Object.defineProperty(aliasedModel, "aliasOf", { value: model, writable: true });
  return aliasedModel as unknown as C;
}

/**
 * The model an alias was made from, or `null` when it is not an alias.
 *
 * @param model Any model class.
 * @returns The underlying model, or `null`.
 */
export function aliasOf(model: ModelClass): ModelClass | null {
  return (model as { aliasOf?: ModelClass }).aliasOf ?? null;
}
