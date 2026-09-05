/**
 * tempest-db-js — capture the query plans of everything a block runs.
 *
 * A development tool for "why is this endpoint slow?", where the honest answer
 * usually needs the database's own opinion rather than a wall-clock number.
 * Wrapping the code beats copying SQL out of a log by hand, because the
 * parameters that go into the plan are the ones the code actually used.
 */

import type { AsyncSession } from "./engine.js";

/** One statement's plan. */
export interface QueryPlan {
  /** The statement that was explained. */
  readonly sql: string;
  /** The parameters it ran with. */
  readonly params: readonly unknown[];
  /** The database's plan, in its own shape (JSON on PostgreSQL, rows on SQLite). */
  readonly plan: unknown;
  /** A one-line, human-readable digest of the plan. */
  summary(): string;
}

/** Everything a block ran, with a plan each. */
export interface ExplainReport {
  /** One entry per statement, in execution order. */
  readonly plans: readonly QueryPlan[];
  /** A multi-line digest of every plan, for a test failure message or a log. */
  summary(): string;
}

/** Options for {@link explainQueries}. */
export interface ExplainOptions {
  /**
   * Run `EXPLAIN ANALYZE`, which **executes** the statement to measure it.
   *
   * Refused for anything that is not a `SELECT`: analyzing an `UPDATE` would
   * apply it a second time.
   */
  readonly analyze?: boolean;
  /** Explain only the statements matching this predicate. */
  readonly filter?: (sql: string) => boolean;
}

/** True for a statement that only reads. */
export function isReadOnlyStatement(sql: string): boolean {
  return /^\s*(select|with)\b/i.test(sql);
}

/**
 * Build the digest of a PostgreSQL JSON plan or a SQLite plan row set.
 *
 * @param plan The raw plan.
 * @returns One line describing it.
 */
export function summarizePlan(plan: unknown): string {
  if (Array.isArray(plan)) {
    const rows = plan as Record<string, unknown>[];
    const details = rows
      .map((row) => row.detail ?? row["QUERY PLAN"])
      .filter((detail): detail is string => typeof detail === "string");
    if (details.length > 0) return details.join(" | ");
  }
  const node = (plan as { Plan?: Record<string, unknown> } | undefined)?.Plan;
  if (node) return describePostgresNode(node);
  return JSON.stringify(plan);
}

/**
 * Describe a PostgreSQL plan node and its children, depth-first.
 *
 * @param node The plan node.
 * @returns The digest.
 */
function describePostgresNode(node: Record<string, unknown>): string {
  const parts: string[] = [];
  const type = node["Node Type"];
  const relation = node["Relation Name"];
  const index = node["Index Name"];
  parts.push(
    [type, relation ? `on ${relation}` : "", index ? `using ${index}` : ""]
      .filter((piece) => piece !== "")
      .join(" "),
  );
  const children = node.Plans;
  if (Array.isArray(children)) {
    for (const child of children as Record<string, unknown>[]) {
      parts.push(describePostgresNode(child));
    }
  }
  return parts.join(" -> ");
}

/** A statement recorded while the block ran. */
export interface RecordedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Turn recorded statements into a report by explaining each one.
 *
 * Kept separate from the recording so the engine owns the driver (which is
 * private) and this module owns the plan shapes.
 *
 * @param session The session to run the `EXPLAIN` statements on.
 * @param statements What the block ran.
 * @param prefix Builds the dialect's `EXPLAIN` prefix.
 * @param options Whether to `ANALYZE`, and which statements to explain.
 * @returns The report.
 * @throws Error When `analyze` is asked for a statement that writes.
 */
export async function buildReport(
  session: AsyncSession,
  statements: readonly RecordedStatement[],
  prefix: (analyze: boolean) => string,
  options?: ExplainOptions,
): Promise<ExplainReport> {
  const analyze = options?.analyze === true;
  const plans: QueryPlan[] = [];
  for (const statement of statements) {
    if (options?.filter && !options.filter(statement.sql)) continue;
    if (analyze && !isReadOnlyStatement(statement.sql)) {
      throw new Error(
        `EXPLAIN ANALYZE executes the statement, so it is refused for a write: ${statement.sql.slice(0, 80)}`,
      );
    }
    const rows = await session
      .raw(`${prefix(analyze)} ${statement.sql}`, statement.params)
      .all();
    const plan = extractPlan(rows as Record<string, unknown>[]);
    plans.push({
      sql: statement.sql,
      params: statement.params,
      plan,
      summary: () => summarizePlan(plan),
    });
  }
  return {
    plans,
    summary: () => plans.map((p) => `${p.summary()}\n  ${p.sql}`).join("\n"),
  };
}

/**
 * Unwrap the rows an `EXPLAIN` returned into the plan itself.
 *
 * PostgreSQL's `FORMAT JSON` returns one row holding an array with one plan;
 * SQLite returns one row per plan step.
 *
 * @param rows The rows the EXPLAIN returned.
 * @returns The plan, in the database's own shape.
 */
function extractPlan(rows: Record<string, unknown>[]): unknown {
  const first = rows[0];
  if (rows.length === 1 && first) {
    const value = first["QUERY PLAN"] ?? Object.values(first)[0];
    const parsed = typeof value === "string" ? tryParseJson(value) : value;
    if (Array.isArray(parsed) && parsed.length === 1) return parsed[0];
    if (parsed !== undefined && typeof parsed === "object") return parsed;
  }
  return rows;
}

/**
 * Parse a JSON string, returning it unchanged when it is not JSON.
 *
 * @param value The text.
 * @returns The parsed value, or the original string.
 */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
