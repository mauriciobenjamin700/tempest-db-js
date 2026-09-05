/**
 * tempest-db-js — text search that survives what users actually type.
 *
 * Two layers, because they answer different questions:
 *
 * - {@link contains} — tokenized, **escaped** substring matching. Identical on
 *   every dialect, needs no extension, no index and no migration. This is what
 *   "find the row whose name contains what the user typed" should use.
 * - {@link fullText} / {@link fullTextRank} — PostgreSQL's `to_tsvector` /
 *   `websearch_to_tsquery` / `ts_rank`: stemming, stop words and a relevance
 *   score. On any other database they fall back to the first layer, which is the
 *   honest degradation — the query still returns the right rows, just without
 *   stemming.
 */

import { type Condition, type Expression, and, or } from "./conditions.js";
import { conditionFromNode, expressionFromNode } from "./conditions.js";
import type { WhereInput } from "./query.js";

/**
 * A PostgreSQL text-search configuration (`regconfig`), such as `"english"` or
 * `"portuguese"`. `"simple"` disables stemming and stop-word removal.
 */
export type TextSearchLanguage = string;

/** Options shared by the full-text helpers. */
export interface TextSearchOptions {
  /** The PostgreSQL text-search configuration. Defaults to `"english"`. */
  readonly language?: TextSearchLanguage;
}

/** Options for {@link contains}. */
export interface ContainsOptions {
  /**
   * Whether a row must match **every** token (default) or any one of them.
   *
   * `"all"` is what a search box wants: typing more words narrows the result.
   */
  readonly match?: "all" | "any";
}

/**
 * Escape the `LIKE` wildcards in a literal, for use with `like` / `ilike`.
 *
 * `%` and `_` are wildcards, and `\` escapes them — so a user searching for
 * `100%` matches every row unless the literal is escaped first. The pattern this
 * produces is meant to be used with an `ESCAPE '\'` clause, which is what the
 * {@link ContainsOptions} operator emits; PostgreSQL assumes that escape by
 * default, SQLite has none until it is given one.
 *
 * @param value The literal the user typed.
 * @returns The same text with `\`, `%` and `_` escaped.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Split a search term into the tokens a row has to match.
 *
 * @param term What the user typed.
 * @returns The non-empty whitespace-separated tokens.
 */
export function tokenize(term: string): string[] {
  return term.split(/\s+/).filter((token) => token.length > 0);
}

/**
 * Case-insensitive substring search across one or more columns.
 *
 * The term is tokenized, and each token is matched — **escaped** — against every
 * listed column; a row matches when every token appears in at least one of them.
 * Behaves the same on every dialect, with no index or extension needed.
 *
 * @param columns The columns to search, by property name.
 * @param term What the user typed.
 * @param options `match: "any"` to require a single token instead of all of them.
 * @returns A condition for `where`, matching nothing when the term is blank.
 * @throws Error When no column is given.
 *
 * @example
 * ```ts
 * select(User).where(contains(["name", "email"], "100% ana"));
 * // (name ILIKE '%100\%%' ESCAPE '\' OR email ILIKE ...) AND (name ILIKE '%ana%' ...)
 * ```
 */
export function contains<Row = Record<string, unknown>>(
  columns: readonly string[],
  term: string,
  options?: ContainsOptions,
): Condition {
  if (columns.length === 0) {
    throw new Error("contains() needs at least one column to search.");
  }
  const tokens = tokenize(term);
  if (tokens.length === 0) return alwaysFalse();
  const perToken = tokens.map((token) =>
    or<Row>(
      ...columns.map((column) => ({ [column]: { iContains: token } }) as WhereInput<Row>),
    ),
  );
  if (options?.match === "any") return or<Row>(...perToken);
  return perToken.length === 1 ? (perToken[0] as Condition) : and<Row>(...perToken);
}

/** A condition matching no row, for a search whose term carried no tokens. */
function alwaysFalse(): Condition {
  return conditionFromNode({
    kind: "compare",
    left: { kind: "value", value: 1 },
    op: "eq",
    right: { kind: "value", value: 0 },
  });
}

/**
 * PostgreSQL full-text search over one or more columns, with a portable fallback.
 *
 * On PostgreSQL this compiles to `to_tsvector(config, col || ' ' || col) @@
 * websearch_to_tsquery(config, term)`, so the search stems (`buying` matches
 * `buy`), drops stop words, and understands the quoting and `-exclusion` syntax
 * users already know from web search boxes.
 *
 * On any other database it compiles to {@link contains} instead — the same rows a
 * substring search would find, without stemming. That is a documented
 * degradation, not a silent one: a dev SQLite database keeps working, and the
 * difference is in ranking quality, not correctness.
 *
 * @param columns The columns to search, by property name.
 * @param term What the user typed.
 * @param options The text-search configuration.
 * @returns A condition for `where`.
 * @throws Error When no column is given.
 */
export function fullText<Row = Record<string, unknown>>(
  columns: readonly string[],
  term: string,
  options?: TextSearchOptions,
): Condition {
  if (columns.length === 0) {
    throw new Error("fullText() needs at least one column to search.");
  }
  return conditionFromNode({
    kind: "fullText",
    columns: [...columns],
    term,
    language: options?.language ?? "english",
    fallback: contains<Row>(columns, term).node,
  });
}

/**
 * The relevance score of a full-text match, for `orderBy`.
 *
 * On PostgreSQL this is `ts_rank(...)`, the number that makes "best match first"
 * mean something. Elsewhere it renders as a constant, so ordering by it is a
 * no-op and the query falls back to whatever other ordering is given — ranking is
 * the part that genuinely does not exist without a text-search engine.
 *
 * @param columns The same columns passed to {@link fullText}.
 * @param term The same term.
 * @param options The same configuration.
 * @returns An expression usable in `orderBy`.
 * @throws Error When no column is given.
 *
 * @example
 * ```ts
 * select(Post)
 *   .where(fullText(["title", "body"], term, { language: "portuguese" }))
 *   .orderBy(fullTextRank(["title", "body"], term, { language: "portuguese" }), "desc");
 * ```
 */
export function fullTextRank(
  columns: readonly string[],
  term: string,
  options?: TextSearchOptions,
): Expression {
  if (columns.length === 0) {
    throw new Error("fullTextRank() needs at least one column to rank on.");
  }
  return expressionFromNode({
    kind: "rank",
    columns: [...columns],
    term,
    language: options?.language ?? "english",
  });
}
