/**
 * Querium — Phase 6: the schema differ.
 *
 * Compares two `SchemaIR`s (current vs target) and emits the typed `Operation[]`
 * that turns one into the other. Purely structural — no SQL, no DB.
 */

import type { ColumnIR, SchemaIR } from "./ir.js";
import type { Operation } from "./operations.js";

/** Stable structural identity of a column, for change detection. */
function columnSignature(col: ColumnIR): string {
  return JSON.stringify({
    type: col.type,
    notNull: col.notNull,
    primaryKey: col.primaryKey,
    default: col.default,
  });
}

/**
 * Diff `current` → `target`, returning the operations to migrate forward.
 *
 * Order: create new tables, then per-table column adds/alters/drops, then drop
 * removed tables last (so nothing depends on a table being dropped first).
 *
 * @param current The current schema (e.g. from migration replay).
 * @param target The desired schema (e.g. from model reflection).
 * @returns The forward operations.
 */
export function diffSchema(current: SchemaIR, target: SchemaIR): Operation[] {
  const ops: Operation[] = [];
  const drops: Operation[] = [];

  for (const [name, targetTable] of Object.entries(target.tables)) {
    const currentTable = current.tables[name];
    if (!currentTable) {
      ops.push({ kind: "create_table", table: targetTable });
      continue;
    }
    // existing table → diff columns
    for (const [colName, targetCol] of Object.entries(targetTable.columns)) {
      const currentCol = currentTable.columns[colName];
      if (!currentCol) {
        ops.push({ kind: "add_column", table: name, column: targetCol });
      } else if (columnSignature(currentCol) !== columnSignature(targetCol)) {
        ops.push({
          kind: "alter_column",
          table: name,
          name: colName,
          from: currentCol,
          to: targetCol,
        });
      }
    }
    for (const [colName, currentCol] of Object.entries(currentTable.columns)) {
      if (!targetTable.columns[colName]) {
        ops.push({ kind: "drop_column", table: name, column: currentCol });
      }
    }
  }

  for (const [name, currentTable] of Object.entries(current.tables)) {
    if (!target.tables[name]) {
      drops.push({ kind: "drop_table", table: currentTable });
    }
  }

  return [...ops, ...drops];
}
