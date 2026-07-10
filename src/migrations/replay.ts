/**
 * tempest-db-js — Phase 6: migration replay → virtual schema IR.
 *
 * Applies a migration's operations to an in-memory `SchemaIR`, building the
 * "current" schema without touching a database. This is the hybrid source of
 * truth for autogenerate: diff the replayed schema against the reflected models.
 */

import { topoOrder } from "./graph.js";
import { type SchemaIR, type TableIR, emptySchema } from "./ir.js";
import type { Operation } from "./operations.js";
import { type Migration, Op } from "./runner.js";

/** Apply one operation to a schema, returning the updated schema. */
export function applyOperation(schema: SchemaIR, op: Operation): SchemaIR {
  const tables: Record<string, TableIR> = { ...schema.tables };
  switch (op.kind) {
    case "create_table":
      tables[op.table.name] = op.table;
      break;
    case "drop_table":
      delete tables[op.table.name];
      break;
    case "rename_table": {
      const t = tables[op.from];
      if (t) {
        delete tables[op.from];
        tables[op.to] = { ...t, name: op.to };
      }
      break;
    }
    case "recreate_table":
      delete tables[op.from.name];
      tables[op.to.name] = op.to;
      break;
    case "add_column": {
      const t = tables[op.table];
      if (t) {
        tables[op.table] = {
          ...t,
          columns: { ...t.columns, [op.column.name]: op.column },
        };
      }
      break;
    }
    case "drop_column": {
      const t = tables[op.table];
      if (t) {
        const columns = { ...t.columns };
        delete columns[op.column.name];
        tables[op.table] = { ...t, columns };
      }
      break;
    }
    case "alter_column": {
      const t = tables[op.table];
      if (t) {
        tables[op.table] = {
          ...t,
          columns: { ...t.columns, [op.name]: op.to },
        };
      }
      break;
    }
    case "rename_column": {
      const t = tables[op.table];
      const col = t?.columns[op.from];
      if (t && col) {
        const columns = { ...t.columns };
        delete columns[op.from];
        columns[op.to] = { ...col, name: op.to };
        tables[op.table] = { ...t, columns };
      }
      break;
    }
    case "add_constraint": {
      const t = tables[op.table];
      if (t) {
        tables[op.table] =
          op.constraint.type === "unique"
            ? {
                ...t,
                uniqueConstraints: [...t.uniqueConstraints, op.constraint.constraint],
              }
            : { ...t, foreignKeys: [...t.foreignKeys, op.constraint.constraint] };
      }
      break;
    }
    case "drop_constraint": {
      const t = tables[op.table];
      if (t) {
        const dropName = op.constraint.constraint.name;
        tables[op.table] =
          op.constraint.type === "unique"
            ? {
                ...t,
                uniqueConstraints: t.uniqueConstraints.filter((u) => u.name !== dropName),
              }
            : {
                ...t,
                foreignKeys: t.foreignKeys.filter((f) => f.name !== dropName),
              };
      }
      break;
    }
    case "execute":
      // raw SQL is opaque to the IR
      break;
  }
  return { tables };
}

/**
 * Replay migrations (in DAG order) into a virtual `SchemaIR` — the "current"
 * schema, computed without a database.
 *
 * @param migrations All known migrations.
 * @returns The schema after applying every migration's `up()`.
 */
export function replaySchema(migrations: readonly Migration[]): SchemaIR {
  let schema = emptySchema();
  for (const migration of topoOrder(migrations)) {
    const op = new Op();
    migration.up(op);
    for (const operation of op.operations) {
      schema = applyOperation(schema, operation);
    }
  }
  return schema;
}
