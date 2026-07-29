import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SqliteDatabase } from "../src/persistence/sqlite-database.js";

describe("SqliteDatabase migrations", () => {
  it("creates a consistent backup before applying a pending migration", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-migration-"));
    const databasePath = join(rootPath, "database", "apinteract.sqlite3");
    const backupDirectory = join(rootPath, "backups");

    try {
      const initial = await SqliteDatabase.open(databasePath, backupDirectory);
      await initial.close();
      const driver = new BetterSqlite3(databasePath);
      driver
        .prepare("DELETE FROM schema_migrations WHERE id = ?")
        .run("0003_temporary_executions");
      driver.close();

      const migrated = await SqliteDatabase.open(databasePath, backupDirectory);
      await migrated.close();

      const backups = await readdir(backupDirectory);
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/^apinteract-before-migration-.+\.sqlite3$/u);
      const backup = await stat(join(backupDirectory, backups[0]!));
      expect(backup.size).toBeGreaterThan(0);
      expect(backup.mode & 0o777).toBe(0o600);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
