/**
 * tempest-db-js — migrations public surface (Phase 6).
 *
 * Alembic-style, anti-"SQL-stitching": a Schema IR + typed operations + a dialect
 * renderer. Reflect models → diff vs current → operations → migration file with
 * `up()`/`down()`; the runner applies them and tracks the revision DAG.
 */

export {
  type ColumnIR,
  type DefaultIR,
  emptySchema,
  reflectSchema,
  reflectTable,
  type SchemaIR,
  type TableIR,
} from "./ir.js";

export {
  invert,
  invertAll,
  IrreversibleMigration,
  type Operation,
} from "./operations.js";

export {
  renderColumnDef,
  renderColumnType,
  renderDefault,
  renderOperation,
} from "./ddl.js";

export { diffSchema } from "./diff.js";

export {
  CyclicMigrationGraph,
  heads,
  type RevisionNode,
  topoOrder,
  UnknownRevision,
} from "./graph.js";

export {
  generateMigration,
  makeRevisionId,
  type MigrationDraft,
} from "./codegen.js";

export { type Migration, MigrationRunner, Op } from "./runner.js";

export {
  checkDrift,
  checkDriftPostgres,
  introspectPostgres,
  introspectSqlite,
  type SqliteAffinity,
  sqliteAffinity,
} from "./introspect.js";

export { applyOperation, replaySchema } from "./replay.js";

export {
  type CliConfig,
  type CliResult,
  defineMigrationConfig,
  runMigrationCli,
} from "./cli.js";
