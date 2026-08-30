/**
 * tempest-db-js — portable SQL expression rendering.
 *
 * A `sql.now()` / `sql.uuidv4()` token is dialect-neutral in the AST and in the
 * migration IR; this is the single place it becomes concrete SQL. Kept in its own
 * module (types only, no runtime imports) so both the query dialect and the DDL
 * renderer share one mapping instead of drifting apart.
 */

import type { Dialect } from "./url.js";

/** The dialect-neutral expression tokens (the non-fragment `PortableExpression`s). */
export type PortableToken = "now" | "current_date" | "current_time" | "uuidv4";

/**
 * Render a portable expression token to SQL for the dialect.
 *
 * @param token The dialect-neutral token.
 * @param dialect The target dialect.
 * @returns The SQL text for that token.
 */
export function renderPortableToken(token: PortableToken, dialect: Dialect): string {
  switch (token) {
    case "now":
      return dialect === "postgresql" ? "now()" : "CURRENT_TIMESTAMP";
    case "current_date":
      return "CURRENT_DATE";
    case "current_time":
      return "CURRENT_TIME";
    case "uuidv4":
      if (dialect === "postgresql") return "gen_random_uuid()";
      if (dialect === "mysql") return "(UUID())";
      return "(lower(hex(randomblob(16))))";
  }
}
