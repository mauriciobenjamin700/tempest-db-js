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
 * Render a reference to the incoming row of an upsert.
 *
 * PostgreSQL and SQLite expose it as the `excluded` pseudo-table; MySQL has no
 * such table and spells the same idea as `VALUES(col)` inside
 * `ON DUPLICATE KEY UPDATE`.
 *
 * @param column The already-quoted column identifier.
 * @param bare The column name without quoting, for MySQL's `VALUES()` form.
 * @param dialect The target dialect.
 * @returns The SQL text.
 */
export function renderExcluded(column: string, bare: string, dialect: Dialect): string {
  return dialect === "mysql" ? `VALUES(${bare})` : `excluded.${column}`;
}

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
      if (dialect === "postgresql") return "now()";
      // SQLite's CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS": no `T`, no
      // milliseconds, no zone. JS parses that as **local** time, so a row written
      // at 21:00Z read back as 00:00Z on a UTC-3 machine, and comparing the column
      // against a bound ISO string compared " " with "T" and silently matched
      // nothing. `strftime` writes exactly the format this package binds and reads.
      if (dialect === "sqlite") return "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
      return "CURRENT_TIMESTAMP";
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
