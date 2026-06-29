/**
 * tempest-db-js — Phase 6: the revision DAG.
 *
 * Migrations form a directed acyclic graph via `downRevision` (a list of parents,
 * so branches and merges are first-class). This module orders them for applying
 * (topological, deterministic) and finds heads.
 */

/** The minimal graph shape a migration must expose. */
export interface RevisionNode {
  readonly revision: string;
  readonly downRevision: readonly string[];
}

/** Raised when the revision graph contains a cycle. */
export class CyclicMigrationGraph extends Error {
  constructor(remaining: readonly string[]) {
    super(`migration graph has a cycle among: ${remaining.join(", ")}`);
    this.name = "CyclicMigrationGraph";
  }
}

/** Raised when a `downRevision` points at a revision that does not exist. */
export class UnknownRevision extends Error {
  constructor(revision: string, parent: string) {
    super(`revision ${revision} references unknown parent ${parent}`);
    this.name = "UnknownRevision";
  }
}

/**
 * Topologically order migrations so every parent precedes its children. Ties are
 * broken by revision id for reproducible builds. Throws on cycles or dangling
 * parents.
 *
 * @param migrations The migrations to order.
 * @returns The migrations in apply order.
 */
export function topoOrder<T extends RevisionNode>(migrations: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const m of migrations) byId.set(m.revision, m);

  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const m of migrations) {
    indegree.set(m.revision, m.downRevision.length);
    for (const parent of m.downRevision) {
      if (!byId.has(parent)) throw new UnknownRevision(m.revision, parent);
      const list = children.get(parent) ?? [];
      list.push(m.revision);
      children.set(parent, list);
    }
  }

  // roots: indegree 0, sorted for determinism
  const ready = migrations
    .filter((m) => (indegree.get(m.revision) ?? 0) === 0)
    .map((m) => m.revision)
    .sort();

  const ordered: T[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    ordered.push(byId.get(id) as T);
    const next = (children.get(id) ?? []).sort();
    for (const child of next) {
      const deg = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, deg);
      if (deg === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  if (ordered.length !== migrations.length) {
    const remaining = migrations
      .map((m) => m.revision)
      .filter((r) => !ordered.some((o) => o.revision === r));
    throw new CyclicMigrationGraph(remaining);
  }
  return ordered;
}

/** Revisions that are nobody's parent — the current head(s) of the graph. */
export function heads<T extends RevisionNode>(migrations: readonly T[]): string[] {
  const parents = new Set<string>();
  for (const m of migrations) for (const p of m.downRevision) parents.add(p);
  return migrations
    .map((m) => m.revision)
    .filter((r) => !parents.has(r))
    .sort();
}
