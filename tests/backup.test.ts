import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BaseRepository,
  Model,
  UnsupportedBackupBackend,
  backupDatabase,
  backupFormat,
  column,
  createEngine,
  restoreDatabase,
  toolUrl,
} from "../src/index.js";

class Note extends Model {
  static override tablename = "notes";
  id = column.integer().primaryKey();
  title = column.varchar(40).notNull();
}

const DDL = "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL)";
const dir = mkdtempSync(join(tmpdir(), "tdbjs-backup-"));

/** Whether a tool is on the PATH, so a test can skip instead of failing. */
function hasTool(tool: string): boolean {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("backup helpers", () => {
  it("picks the format from the extension", () => {
    expect(backupFormat("db.sql")).toBe("plain");
    expect(backupFormat("db.dump")).toBe("custom");
    expect(backupFormat("db")).toBe("custom");
  });

  it("strips the driver suffix a client tool would not understand", () => {
    expect(toolUrl("postgresql+asyncpg://u:p@h/db")).toBe("postgresql://u:p@h/db");
    expect(toolUrl("sqlite+better-sqlite3:///app.db")).toBe("sqlite:///app.db");
    expect(toolUrl("postgresql://u@h/db")).toBe("postgresql://u@h/db");
  });

  it("refuses a dialect it does not cover", async () => {
    await expect(backupDatabase("mysql://root@localhost/app", "x.sql")).rejects.toThrow(
      UnsupportedBackupBackend,
    );
  });
});

describe("SQLite backup and restore", () => {
  it("round-trips the rows through VACUUM INTO", async () => {
    const source = join(dir, "source.db");
    const dump = join(dir, "snapshot.db");
    const target = join(dir, "restored.db");

    {
      await using engine = createEngine(`sqlite:///${source}`, {
        sqlite: { journalMode: "wal" },
      });
      // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
      await (engine as any).driver.execute(DDL, []);
      await new BaseRepository(Note, engine.session()).createMany([
        { id: 1, title: "um" },
        { id: 2, title: "dois" },
      ]);
    }

    const result = await backupDatabase(`sqlite:///${source}`, dump);
    expect(result.via).toBe("VACUUM INTO");
    expect(existsSync(dump)).toBe(true);

    await restoreDatabase(`sqlite:///${target}`, dump);
    const restored = createEngine(`sqlite:///${target}`);
    const rows = await new BaseRepository(Note, restored.session()).list();
    expect(rows.map((r) => r.title)).toEqual(["um", "dois"]);
    await restored.close();
  });

  it("takes a consistent snapshot of a WAL database", async () => {
    const source = join(dir, "wal.db");
    const dump = join(dir, "wal-snapshot.db");
    const engine = createEngine(`sqlite:///${source}`, {
      sqlite: { journalMode: "wal" },
    });
    // biome-ignore lint/suspicious/noExplicitAny: driver access for DDL in tests.
    await (engine as any).driver.execute(DDL, []);
    const repo = new BaseRepository(Note, engine.session());
    await repo.create({ id: 1, title: "antes do backup" });

    // The connection stays open — a plain file copy would miss the WAL contents.
    await backupDatabase(`sqlite:///${source}`, dump);
    await engine.close();

    const restored = createEngine(`sqlite:///${dump}`);
    expect(await new BaseRepository(Note, restored.session()).count()).toBe(1);
    await restored.close();
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL || !hasTool("pg_dump"))(
  "PostgreSQL backup",
  () => {
    it("writes a custom-format dump a restore can read", async () => {
      const url = process.env.TEST_DATABASE_URL as string;
      const dump = join(dir, "pg.dump");
      const result = await backupDatabase(url, dump);
      expect(result.via).toBe("pg_dump");
      expect(existsSync(dump)).toBe(true);
    });
  },
);
