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

  it("retains existing collections with an empty profile during migration", async () => {
    const rootPath = await mkdtemp(
      join(tmpdir(), "apinteract-collection-migration-"),
    );
    const databasePath = join(rootPath, "apinteract.sqlite3");
    const backupDirectory = join(rootPath, "backups");

    try {
      const current = await SqliteDatabase.open(databasePath, backupDirectory);
      await current.close();
      const driver = new BetterSqlite3(databasePath);
      const userId = Buffer.alloc(16, 1);
      const workspaceId = Buffer.alloc(16, 2);
      const collectionId = Buffer.alloc(16, 3);
      driver
        .prepare(
          "INSERT INTO users VALUES (?, 'active', 'migration-user', 'Migration User', 0, ?, NULL)",
        )
        .run(userId, Date.now());
      driver
        .prepare(
          "INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, 'Workspace', ?, ?)",
        )
        .run(workspaceId, userId, Date.now());
      driver
        .prepare(
          "INSERT INTO workspace_tree_nodes VALUES (?, ?, NULL, 'collection', 0, 'Existing', 0, ?)",
        )
        .run(collectionId, workspaceId, Date.now());
      driver.exec("DROP TABLE collection_profiles");
      driver
        .prepare("DELETE FROM schema_migrations WHERE id = ?")
        .run("0004_collection_profiles");
      driver.close();

      const migrated = await SqliteDatabase.open(databasePath, backupDirectory);
      const collection = await migrated.db
        .selectFrom("workspace_tree_nodes")
        .leftJoin(
          "collection_profiles",
          "collection_profiles.collection_id",
          "workspace_tree_nodes.id",
        )
        .select([
          "workspace_tree_nodes.name",
          "collection_profiles.headers_json",
        ])
        .where("workspace_tree_nodes.id", "=", collectionId)
        .executeTakeFirstOrThrow();
      expect(collection).toEqual({ name: "Existing", headers_json: null });
      await migrated.close();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("preserves scripts when upgrading the legacy request draft layout", async () => {
    const rootPath = await mkdtemp(
      join(tmpdir(), "apinteract-composed-target-migration-"),
    );
    const databasePath = join(rootPath, "apinteract.sqlite3");
    const backupDirectory = join(rootPath, "backups");

    try {
      const current = await SqliteDatabase.open(databasePath, backupDirectory);
      await current.close();
      const driver = new BetterSqlite3(databasePath);
      const userId = Buffer.alloc(16, 1);
      const workspaceId = Buffer.alloc(16, 2);
      const requestId = Buffer.alloc(16, 3);
      const now = Date.now();
      driver
        .prepare(
          "INSERT INTO users VALUES (?, 'active', 'script-migration-user', 'Script Migration User', 0, ?, NULL)",
        )
        .run(userId, now);
      driver
        .prepare(
          "INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, 'Workspace', ?, ?)",
        )
        .run(workspaceId, userId, now);
      driver
        .prepare(
          "INSERT INTO workspace_tree_nodes VALUES (?, ?, NULL, 'request', 0, 'Existing request', 0, ?)",
        )
        .run(requestId, workspaceId, now);
      driver
        .prepare(
          `INSERT INTO request_drafts (
            request_id, draft_revision, method, target_mode, target_url,
            query_mode, query_json, headers_json, body_text,
            pre_request_script, post_response_script, updated_by, updated_at
          ) VALUES (?, 4, 'POST', 'absolute', 'https://example.test/legacy',
            'structured', '[]', '[]', 'legacy body', ?, ?, ?, ?)`,
        )
        .run(
          requestId,
          'asdk.log.info("before");',
          'asdk.test("after", () => {});',
          userId,
          now,
        );

      driver.pragma("foreign_keys = OFF");
      driver.exec(`
        CREATE TABLE request_drafts_legacy (
          request_id BLOB PRIMARY KEY REFERENCES workspace_tree_nodes(id) ON DELETE CASCADE,
          draft_revision INTEGER NOT NULL CHECK(draft_revision >= 0),
          method TEXT NOT NULL CHECK(method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')),
          target_mode TEXT NOT NULL CHECK(target_mode = 'absolute'),
          target_url TEXT NOT NULL,
          query_mode TEXT NOT NULL CHECK(query_mode = 'structured'),
          query_json TEXT NOT NULL,
          headers_json TEXT NOT NULL,
          body_text TEXT NOT NULL,
          updated_by BLOB NOT NULL REFERENCES users(id),
          updated_at INTEGER NOT NULL,
          pre_request_script TEXT NOT NULL DEFAULT '',
          post_response_script TEXT NOT NULL DEFAULT ''
        ) STRICT;
        INSERT INTO request_drafts_legacy (
          request_id, draft_revision, method, target_mode, target_url,
          query_mode, query_json, headers_json, body_text, updated_by,
          updated_at, pre_request_script, post_response_script
        )
        SELECT
          request_id, draft_revision, method, target_mode, target_url,
          query_mode, query_json, headers_json, body_text, updated_by,
          updated_at, pre_request_script, post_response_script
        FROM request_drafts;
        DROP TABLE request_drafts;
        ALTER TABLE request_drafts_legacy RENAME TO request_drafts;
        ALTER TABLE workspaces DROP COLUMN base_url_template;
        ALTER TABLE collection_profiles DROP COLUMN path_prefix;
        DELETE FROM schema_migrations WHERE id = '0011_composed_targets';
      `);
      driver.pragma("foreign_keys = ON");
      driver.close();

      const migrated = await SqliteDatabase.open(databasePath, backupDirectory);
      const draft = await migrated.db
        .selectFrom("request_drafts")
        .select([
          "target_mode",
          "target_url",
          "body_json",
          "pre_request_script",
          "post_response_script",
          "updated_by",
        ])
        .where("request_id", "=", requestId)
        .executeTakeFirstOrThrow();
      expect(draft).toEqual({
        target_mode: "absolute",
        target_url: "https://example.test/legacy",
        body_json: '{"kind":"text","contentType":null,"text":"legacy body"}',
        pre_request_script: 'asdk.log.info("before");',
        post_response_script: 'asdk.test("after", () => {});',
        updated_by: userId,
      });
      await migrated.close();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
