import { NodeSqliteDriver } from "../../src/engine.js";
// Fixture migration config loaded by the bin tests via `--config`.
// A `.ts` fixture so Vitest's module runner resolves the `../../src` imports;
// real users author a `.mjs`/`.js`/`.cjs` config (see the docs).
import { Model, column } from "../../src/index.js";
import { defineMigrationConfig } from "../../src/migrations/cli.js";
import { type Migration, type Op, reflectTable } from "../../src/migrations/index.js";

class User extends Model {
  static override tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
}

const usersTable = reflectTable(User);

const initial: Migration = {
  revision: "0001_init",
  downRevision: [],
  label: "init",
  up: (op: Op): void => op.createTable(usersTable),
  down: (op: Op): void => op.dropTable(usersTable),
};

export default defineMigrationConfig({
  driver: NodeSqliteDriver.open(":memory:"),
  dialect: "sqlite",
  migrations: [initial],
  models: [User],
});
