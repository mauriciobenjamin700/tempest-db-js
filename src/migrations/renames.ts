/**
 * tempest-db-js — Phase 6: rename detection.
 *
 * The differ ({@link diffSchema}) is deliberately conservative: a renamed column
 * looks like a drop + add, and a renamed table like a drop + create. That is the
 * *safe* default (never guesses), but it loses data. This module turns those
 * add/drop pairs into rename *candidates* the CLI can confirm — interactively at
 * a TTY, or explicitly via flags — and folds confirmed ones back into a single
 * `rename_table` / `rename_column` operation.
 *
 * Everything here is pure and structural (no SQL, no DB, no I/O), so the
 * detection and folding are fully testable; the actual prompting lives in the
 * `tempest-db` bin.
 */

import type { ColumnIR } from "./ir.js";
import type { Operation } from "./operations.js";

/** A possible rename the differ emitted as a drop + add/create pair. */
export type RenameCandidate =
  | { readonly kind: "table"; readonly from: string; readonly to: string }
  | {
      readonly kind: "column";
      readonly table: string;
      readonly from: string;
      readonly to: string;
    };

/** Structural identity of a column, ignoring its name. */
function columnShape(col: ColumnIR): string {
  return JSON.stringify({
    type: col.type,
    notNull: col.notNull,
    primaryKey: col.primaryKey,
    default: col.default,
  });
}

/** Structural identity of a table's columns, ignoring the table name. */
function tableShape(columns: Readonly<Record<string, ColumnIR>>): string {
  return Object.entries(columns)
    .map(([name, col]) => `${name}:${columnShape(col)}`)
    .sort()
    .join("|");
}

/**
 * Detect rename candidates in a forward operation list.
 *
 * A table rename is a `create_table` + `drop_table` whose column shapes match
 * exactly. A column rename is an `add_column` + `drop_column` on the same table
 * whose column shapes match exactly. Only unambiguous 1:1 shape matches are
 * reported — if two dropped columns share a shape, neither is offered (the
 * mapping would be a guess).
 *
 * @param ops The forward operations from {@link diffSchema}.
 * @returns The rename candidates found (never mutates `ops`).
 */
export function detectRenames(ops: readonly Operation[]): RenameCandidate[] {
  const candidates: RenameCandidate[] = [];

  // --- table renames ---
  const creates = ops.filter((o) => o.kind === "create_table");
  const tableDrops = ops.filter((o) => o.kind === "drop_table");
  const takenCreate = new Set<string>();
  const takenDrop = new Set<string>();
  for (const create of creates) {
    const createShape = tableShape(create.table.columns);
    const matches = tableDrops.filter(
      (d) => !takenDrop.has(d.table.name) && tableShape(d.table.columns) === createShape,
    );
    // Only a unique match is a safe rename; ambiguity → leave as drop + create.
    const uniqueCreate =
      creates.filter(
        (c) =>
          !takenCreate.has(c.table.name) && tableShape(c.table.columns) === createShape,
      ).length === 1;
    if (matches.length === 1 && uniqueCreate) {
      const drop = matches[0] as Extract<Operation, { kind: "drop_table" }>;
      if (drop.table.name !== create.table.name) {
        candidates.push({ kind: "table", from: drop.table.name, to: create.table.name });
        takenCreate.add(create.table.name);
        takenDrop.add(drop.table.name);
      }
    }
  }

  // --- column renames (per table) ---
  const adds = ops.filter((o) => o.kind === "add_column");
  const colDrops = ops.filter((o) => o.kind === "drop_column");
  const tables = new Set([...adds.map((o) => o.table), ...colDrops.map((o) => o.table)]);
  for (const table of tables) {
    const tableAdds = adds.filter((o) => o.table === table);
    const tableColDrops = colDrops.filter((o) => o.table === table);
    const takenAdd = new Set<string>();
    const takenColDrop = new Set<string>();
    for (const add of tableAdds) {
      const shape = columnShape(add.column);
      const dropMatches = tableColDrops.filter(
        (d) => !takenColDrop.has(d.column.name) && columnShape(d.column) === shape,
      );
      const addMatches = tableAdds.filter(
        (a) => !takenAdd.has(a.column.name) && columnShape(a.column) === shape,
      );
      if (dropMatches.length === 1 && addMatches.length === 1) {
        const drop = dropMatches[0] as Extract<Operation, { kind: "drop_column" }>;
        candidates.push({
          kind: "column",
          table,
          from: drop.column.name,
          to: add.column.name,
        });
        takenAdd.add(add.column.name);
        takenColDrop.add(drop.column.name);
      }
    }
  }

  return candidates;
}

/** Match a table-rename candidate against an op pair. */
function isTableRename(
  op: Operation,
  r: Extract<RenameCandidate, { kind: "table" }>,
): boolean {
  return (
    (op.kind === "create_table" && op.table.name === r.to) ||
    (op.kind === "drop_table" && op.table.name === r.from)
  );
}

/** Match a column-rename candidate against an op pair. */
function isColumnRename(
  op: Operation,
  r: Extract<RenameCandidate, { kind: "column" }>,
): boolean {
  return (
    (op.kind === "add_column" && op.table === r.table && op.column.name === r.to) ||
    (op.kind === "drop_column" && op.table === r.table && op.column.name === r.from)
  );
}

/**
 * Fold confirmed renames into an operation list: each confirmed candidate's
 * drop + add/create pair is removed and replaced by a single rename operation,
 * inserted at the position of the first op it replaces (preserving order).
 *
 * @param ops The forward operations from {@link diffSchema}.
 * @param confirmed The rename candidates the user accepted.
 * @returns A new operation list with renames applied.
 */
export function applyRenames(
  ops: readonly Operation[],
  confirmed: readonly RenameCandidate[],
): Operation[] {
  const out: Operation[] = [];
  const emitted = new Set<RenameCandidate>();

  for (const op of ops) {
    const match = confirmed.find((r) =>
      r.kind === "table" ? isTableRename(op, r) : isColumnRename(op, r),
    );
    if (!match) {
      out.push(op);
      continue;
    }
    // Emit the rename once (at the first op of the pair); skip both members.
    if (!emitted.has(match)) {
      emitted.add(match);
      out.push(
        match.kind === "table"
          ? { kind: "rename_table", from: match.from, to: match.to }
          : { kind: "rename_column", table: match.table, from: match.from, to: match.to },
      );
    }
  }
  return out;
}
