/**
 * tempest-db-js — Phase 6: the schema differ.
 *
 * Compares two `SchemaIR`s (current vs target) and emits the typed `Operation[]`
 * that turns one into the other. Purely structural — no SQL, no DB.
 */

import type {
  ColumnIR,
  ForeignKeyIR,
  NamedConstraint,
  SchemaIR,
  TableIR,
  UniqueConstraintIR,
} from "./ir.js";
import type { Operation } from "./operations.js";

/** Stable structural identity of a column, for change detection. */
function columnSignature(col: ColumnIR): string {
  return JSON.stringify({
    type: col.type,
    notNull: col.notNull,
    primaryKey: col.primaryKey,
    default: col.default,
    unique: col.unique,
    references: col.references,
  });
}

/** Stable structural identity of a table-level constraint (name excluded). */
function uniqueSignature(uc: UniqueConstraintIR): string {
  return JSON.stringify({ columns: uc.columns });
}

function foreignKeySignature(fk: ForeignKeyIR): string {
  return JSON.stringify({
    columns: fk.columns,
    refTable: fk.refTable,
    refColumns: fk.refColumns,
    onDelete: fk.onDelete ?? null,
    onUpdate: fk.onUpdate ?? null,
  });
}

/**
 * Diff the table-level constraints of an existing table, keyed by name. Emits
 * `drop_constraint` for removed/changed and `add_constraint` for added/changed.
 */
function diffConstraints(current: TableIR, target: TableIR): Operation[] {
  const ops: Operation[] = [];
  const table = target.name;

  const currentUq = new Map(current.uniqueConstraints.map((u) => [u.name, u]));
  const targetUq = new Map(target.uniqueConstraints.map((u) => [u.name, u]));
  for (const [name, cur] of currentUq) {
    const tgt = targetUq.get(name);
    if (!tgt || uniqueSignature(cur) !== uniqueSignature(tgt)) {
      ops.push(dropUnique(table, cur));
    }
  }
  for (const [name, tgt] of targetUq) {
    const cur = currentUq.get(name);
    if (!cur || uniqueSignature(cur) !== uniqueSignature(tgt)) {
      ops.push(addUnique(table, tgt));
    }
  }

  const currentFk = new Map(current.foreignKeys.map((f) => [f.name, f]));
  const targetFk = new Map(target.foreignKeys.map((f) => [f.name, f]));
  for (const [name, cur] of currentFk) {
    const tgt = targetFk.get(name);
    if (!tgt || foreignKeySignature(cur) !== foreignKeySignature(tgt)) {
      ops.push(dropForeignKey(table, cur));
    }
  }
  for (const [name, tgt] of targetFk) {
    const cur = currentFk.get(name);
    if (!cur || foreignKeySignature(cur) !== foreignKeySignature(tgt)) {
      ops.push(addForeignKey(table, tgt));
    }
  }

  return ops;
}

function uniqueNamed(uc: UniqueConstraintIR): NamedConstraint {
  return { type: "unique", constraint: uc };
}
function foreignKeyNamed(fk: ForeignKeyIR): NamedConstraint {
  return { type: "foreignKey", constraint: fk };
}
function addUnique(table: string, uc: UniqueConstraintIR): Operation {
  return { kind: "add_constraint", table, constraint: uniqueNamed(uc) };
}
function dropUnique(table: string, uc: UniqueConstraintIR): Operation {
  return { kind: "drop_constraint", table, constraint: uniqueNamed(uc) };
}
function addForeignKey(table: string, fk: ForeignKeyIR): Operation {
  return { kind: "add_constraint", table, constraint: foreignKeyNamed(fk) };
}
function dropForeignKey(table: string, fk: ForeignKeyIR): Operation {
  return { kind: "drop_constraint", table, constraint: foreignKeyNamed(fk) };
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
    ops.push(...diffConstraints(currentTable, targetTable));
  }

  for (const [name, currentTable] of Object.entries(current.tables)) {
    if (!target.tables[name]) {
      drops.push({ kind: "drop_table", table: currentTable });
    }
  }

  return [...ops, ...drops];
}
