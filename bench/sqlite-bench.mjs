/**
 * tempest-db-js — SQLite micro-benchmark vs Drizzle and Kysely.
 *
 * Runs the same four workloads (bulk insert, full scan, filtered scan, point
 * lookups) against:
 *   - raw node:sqlite (the practical floor)
 *   - tempest-db-js   (node:sqlite driver)
 *   - Drizzle ORM     (better-sqlite3)
 *   - Kysely          (better-sqlite3)
 *
 * Run `npm run build` first (this imports the compiled dist), then:
 *   node bench/sqlite-bench.mjs [rows] [reps]
 *
 * The libraries sit on different drivers (node:sqlite vs better-sqlite3) and
 * Kysely's API is async, so read the numbers as "each library on its idiomatic
 * stack", not a pure driver shootout. Lower is better.
 */

import { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3";
import { and, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Kysely, SqliteDialect } from "kysely";
import { Model, column, createSyncEngine, insert, select } from "../dist/index.js";

const ROWS = Number(process.argv[2] ?? 20_000);
const REPS = Number(process.argv[3] ?? 5);
const LOOKUPS = 1_000;
const DDL =
  "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL, active INTEGER NOT NULL)";

/** Deterministic rows (no Math.random → stable across runs). */
const DATA = Array.from({ length: ROWS }, (_, i) => ({
  id: i + 1,
  name: `user_${i}`,
  age: 18 + (i % 60),
  active: i % 2,
}));

/** Time an async `fn` REPS times; return the median wall-clock ms. */
async function median(fn) {
  const samples = [];
  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

// --------------------------------------------------------------------------
// raw node:sqlite (floor)
// --------------------------------------------------------------------------
async function benchRaw() {
  const db = new DatabaseSync(":memory:");
  db.exec(DDL);
  const ins = db.prepare("INSERT INTO users (id,name,age,active) VALUES (?,?,?,?)");
  const scan = db.prepare("SELECT * FROM users");
  const filter = db.prepare("SELECT * FROM users WHERE age > ? AND active = ?");
  const lookup = db.prepare("SELECT * FROM users WHERE id = ?");

  const insertMs = await median(() => {
    db.exec("DELETE FROM users");
    db.exec("BEGIN");
    for (const r of DATA) ins.run(r.id, r.name, r.age, r.active);
    db.exec("COMMIT");
  });
  const scanMs = await median(() => scan.all());
  const filterMs = await median(() => filter.all(40, 1));
  const lookupMs = await median(() => {
    for (let i = 1; i <= LOOKUPS; i += 1) lookup.get(i);
  });
  db.close();
  return { insertMs, scanMs, filterMs, lookupMs };
}

// --------------------------------------------------------------------------
// tempest-db-js
// --------------------------------------------------------------------------
class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  age = column.integer().notNull();
  active = column.integer().notNull();
}

async function benchTempest() {
  const engine = createSyncEngine("sqlite://:memory:");
  const s = engine.session();
  engine.driver.execute(DDL, []); // private driver — DDL only

  const insertMs = await median(() => {
    engine.driver.execute("DELETE FROM users", []);
    s.transaction((tx) => {
      for (const r of DATA) tx.execute(insert(User).values(r));
    });
  });
  const scanMs = await median(() => s.execute(select(User)).all());
  const filterMs = await median(() =>
    s.execute(select(User).where({ age: { gt: 40 }, active: 1 })).all(),
  );
  const lookupMs = await median(() => {
    for (let i = 1; i <= LOOKUPS; i += 1)
      s.execute(select(User).where({ id: i })).first();
  });
  engine.close();
  return { insertMs, scanMs, filterMs, lookupMs };
}

// --------------------------------------------------------------------------
// Drizzle (better-sqlite3)
// --------------------------------------------------------------------------
const usersD = sqliteTable("users", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  age: integer("age").notNull(),
  active: integer("active").notNull(),
});

async function benchDrizzle() {
  const sqlite = new Database(":memory:");
  sqlite.exec(DDL);
  const db = drizzle(sqlite);

  const insertMs = await median(() => {
    sqlite.exec("DELETE FROM users");
    sqlite.transaction(() => {
      for (const r of DATA) db.insert(usersD).values(r).run();
    })();
  });
  const scanMs = await median(() => db.select().from(usersD).all());
  const filterMs = await median(() =>
    db
      .select()
      .from(usersD)
      .where(and(gt(usersD.age, 40), eq(usersD.active, 1)))
      .all(),
  );
  const lookupMs = await median(() => {
    for (let i = 1; i <= LOOKUPS; i += 1)
      db.select().from(usersD).where(eq(usersD.id, i)).get();
  });
  sqlite.close();
  return { insertMs, scanMs, filterMs, lookupMs };
}

// --------------------------------------------------------------------------
// Kysely (better-sqlite3) — async API
// --------------------------------------------------------------------------
async function benchKysely() {
  const sqlite = new Database(":memory:");
  sqlite.exec(DDL);
  const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });

  const insertMs = await median(async () => {
    sqlite.exec("DELETE FROM users");
    await db.transaction().execute(async (tx) => {
      for (const r of DATA) await tx.insertInto("users").values(r).execute();
    });
  });
  const scanMs = await median(() => db.selectFrom("users").selectAll().execute());
  const filterMs = await median(() =>
    db
      .selectFrom("users")
      .selectAll()
      .where("age", ">", 40)
      .where("active", "=", 1)
      .execute(),
  );
  const lookupMs = await median(async () => {
    for (let i = 1; i <= LOOKUPS; i += 1)
      await db.selectFrom("users").selectAll().where("id", "=", i).executeTakeFirst();
  });
  await db.destroy();
  return { insertMs, scanMs, filterMs, lookupMs };
}

// --------------------------------------------------------------------------
// report
// --------------------------------------------------------------------------
async function main() {
  console.log(
    `\ntempest-db-js SQLite benchmark — ${ROWS.toLocaleString()} rows, median of ${REPS}\n`,
  );
  const results = {
    "raw node:sqlite": await benchRaw(),
    "tempest-db-js": await benchTempest(),
    drizzle: await benchDrizzle(),
    kysely: await benchKysely(),
  };

  const cols = ["insertMs", "scanMs", "filterMs", "lookupMs"];
  const labels = {
    insertMs: `insert ${ROWS}`,
    scanMs: "scan all",
    filterMs: "filter scan",
    lookupMs: `${LOOKUPS} lookups`,
  };
  const pad = (s, n) => String(s).padEnd(n);
  const padS = (s, n) => String(s).padStart(n);
  const header = pad("library", 18) + cols.map((c) => padS(labels[c], 16)).join("");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const [name, r] of Object.entries(results)) {
    console.log(
      pad(name, 18) + cols.map((c) => padS(`${r[c].toFixed(2)}ms`, 16)).join(""),
    );
  }
  console.log("\n(each library on its idiomatic driver; lower is better)\n");
}

main();
