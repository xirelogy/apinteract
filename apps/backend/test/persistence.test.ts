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

  it("migrates environment variables and secrets losslessly into shared profiles", async () => {
    const rootPath = await mkdtemp(
      join(tmpdir(), "apinteract-variable-scope-migration-"),
    );
    const databasePath = join(rootPath, "apinteract.sqlite3");
    const backupDirectory = join(rootPath, "backups");

    try {
      const current = await SqliteDatabase.open(databasePath, backupDirectory);
      await current.close();
      const driver = new BetterSqlite3(databasePath);
      const userId = Buffer.alloc(16, 1);
      const sessionId = Buffer.alloc(16, 2);
      const familyId = Buffer.alloc(16, 3);
      const workspaceId = Buffer.alloc(16, 4);
      const environmentId = Buffer.alloc(16, 5);
      const valueId = Buffer.alloc(16, 6);
      const secretId = Buffer.alloc(16, 7);
      const aliasId = Buffer.alloc(16, 8);
      const unsetId = Buffer.alloc(16, 9);
      const createdAt = 1_700_000_000_000;
      const updatedAt = createdAt + 1_000;
      driver
        .prepare(
          "INSERT INTO users VALUES (?, 'active', 'variable-migration-user', 'Variable Migration User', 0, ?, NULL)",
        )
        .run(userId, createdAt);
      driver
        .prepare(
          `INSERT INTO sessions (
            id, user_id, family_id, status, created_at, last_seen_at,
            absolute_expires_at
          ) VALUES (?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          sessionId,
          userId,
          familyId,
          createdAt,
          updatedAt,
          updatedAt + 60_000,
        );
      driver
        .prepare(
          "INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, 'Workspace', ?, ?)",
        )
        .run(workspaceId, userId, createdAt);
      driver
        .prepare(
          `INSERT INTO environments (
            id, workspace_id, name, name_key, revision, created_by, created_at,
            updated_by, updated_at
          ) VALUES (?, ?, 'Legacy', 'legacy', 4, ?, ?, ?, ?)`,
        )
        .run(environmentId, workspaceId, userId, createdAt, userId, updatedAt);
      driver
        .prepare(
          `INSERT INTO session_workspace_environments (
            session_id, workspace_id, selected_environment_id, updated_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(sessionId, workspaceId, environmentId, updatedAt);

      driver.pragma("foreign_keys = OFF");
      driver.exec(`
        DROP TABLE variable_secrets;
        DROP TABLE variables;
        DROP TABLE variable_profiles;

        CREATE TABLE environment_variables (
          id BLOB PRIMARY KEY CHECK(length(id) = 16),
          environment_id BLOB NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK(position >= 0),
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('value', 'secret', 'alias', 'unset')),
          value_text TEXT,
          alias_target TEXT,
          UNIQUE(environment_id, position),
          UNIQUE(environment_id, name),
          CHECK (
            (kind = 'value' AND value_text IS NOT NULL AND alias_target IS NULL) OR
            (kind = 'alias' AND value_text IS NULL AND alias_target IS NOT NULL) OR
            (kind IN ('secret', 'unset') AND value_text IS NULL AND alias_target IS NULL)
          )
        ) STRICT;
        CREATE INDEX environment_variables_environment
          ON environment_variables(environment_id, position);

        CREATE TABLE environment_variable_secrets (
          variable_id BLOB PRIMARY KEY REFERENCES environment_variables(id) ON DELETE CASCADE,
          version INTEGER NOT NULL CHECK(version >= 1),
          storage_format TEXT NOT NULL CHECK(storage_format = 'plaintext-v1'),
          payload TEXT
        ) STRICT;

        DELETE FROM schema_migrations WHERE id = '0006_variable_scopes';
      `);
      driver.pragma("foreign_keys = ON");
      driver
        .prepare(
          `INSERT INTO environment_variables (
            id, environment_id, position, name, kind, value_text, alias_target
          ) VALUES
            (?, ?, 0, 'base_url', 'value', 'https://legacy.example', NULL),
            (?, ?, 1, 'token', 'secret', NULL, NULL),
            (?, ?, 2, 'auth', 'alias', NULL, 'token'),
            (?, ?, 3, 'removed', 'unset', NULL, NULL)`,
        )
        .run(
          valueId,
          environmentId,
          secretId,
          environmentId,
          aliasId,
          environmentId,
          unsetId,
          environmentId,
        );
      driver
        .prepare(
          `INSERT INTO environment_variable_secrets (
            variable_id, version, storage_format, payload
          ) VALUES (?, 7, 'plaintext-v1', 'legacy-secret')`,
        )
        .run(secretId);
      driver.close();

      const migrated = await SqliteDatabase.open(databasePath, backupDirectory);
      const profile = await migrated.db
        .selectFrom("variable_profiles")
        .select([
          "id",
          "workspace_id",
          "scope_kind",
          "scope_id",
          "revision",
          "updated_by",
          "updated_at",
        ])
        .where("scope_kind", "=", "environment")
        .where("scope_id", "=", environmentId)
        .executeTakeFirstOrThrow();
      expect(profile).toEqual({
        id: environmentId,
        workspace_id: workspaceId,
        scope_kind: "environment",
        scope_id: environmentId,
        revision: 4,
        updated_by: userId,
        updated_at: updatedAt,
      });
      const variables = await migrated.db
        .selectFrom("variables")
        .select([
          "id",
          "profile_id",
          "position",
          "name",
          "kind",
          "value_text",
          "alias_target",
        ])
        .where("profile_id", "=", environmentId)
        .orderBy("position")
        .execute();
      expect(variables).toEqual([
        {
          id: valueId,
          profile_id: environmentId,
          position: 0,
          name: "base_url",
          kind: "value",
          value_text: "https://legacy.example",
          alias_target: null,
        },
        {
          id: secretId,
          profile_id: environmentId,
          position: 1,
          name: "token",
          kind: "secret",
          value_text: null,
          alias_target: null,
        },
        {
          id: aliasId,
          profile_id: environmentId,
          position: 2,
          name: "auth",
          kind: "alias",
          value_text: null,
          alias_target: "token",
        },
        {
          id: unsetId,
          profile_id: environmentId,
          position: 3,
          name: "removed",
          kind: "unset",
          value_text: null,
          alias_target: null,
        },
      ]);
      await expect(
        migrated.db
          .selectFrom("variable_secrets")
          .selectAll()
          .where("variable_id", "=", secretId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        variable_id: secretId,
        version: 7,
        storage_format: "plaintext-v1",
        payload: "legacy-secret",
      });
      await expect(
        migrated.db
          .selectFrom("session_workspace_environments")
          .select(["selected_environment_id", "updated_at"])
          .where("session_id", "=", sessionId)
          .where("workspace_id", "=", workspaceId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        selected_environment_id: environmentId,
        updated_at: updatedAt,
      });
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

  it("adds empty documentation fields when upgrading the prior schema", async () => {
    const rootPath = await mkdtemp(
      join(tmpdir(), "apinteract-documentation-migration-"),
    );
    const databasePath = join(rootPath, "apinteract.sqlite3");
    const backupDirectory = join(rootPath, "backups");

    try {
      const current = await SqliteDatabase.open(databasePath, backupDirectory);
      await current.close();
      const driver = new BetterSqlite3(databasePath);
      driver.exec(`
        ALTER TABLE workspaces DROP COLUMN description_text;
        ALTER TABLE workspaces DROP COLUMN notes_markdown;
        ALTER TABLE collection_profiles DROP COLUMN description_text;
        ALTER TABLE collection_profiles DROP COLUMN notes_markdown;
        ALTER TABLE environments DROP COLUMN description_text;
        ALTER TABLE environments DROP COLUMN notes_markdown;
        ALTER TABLE request_drafts DROP COLUMN description_text;
        ALTER TABLE request_drafts DROP COLUMN notes_markdown;
        ALTER TABLE variables DROP COLUMN description_text;
        DELETE FROM schema_migrations WHERE id = '0016_resource_documentation';
      `);
      driver.close();

      const migrated = await SqliteDatabase.open(databasePath, backupDirectory);
      const tables = [
        ["workspaces", "description_text"],
        ["workspaces", "notes_markdown"],
        ["collection_profiles", "description_text"],
        ["collection_profiles", "notes_markdown"],
        ["environments", "description_text"],
        ["environments", "notes_markdown"],
        ["request_drafts", "description_text"],
        ["request_drafts", "notes_markdown"],
        ["variables", "description_text"],
      ] as const;
      const migratedDriver = new BetterSqlite3(databasePath, {
        readonly: true,
      });
      for (const [table, column] of tables) {
        const columns = migratedDriver.pragma(`table_info(${table})`) as {
          readonly name: string;
          readonly notnull: number;
          readonly dflt_value: string | null;
        }[];
        expect(columns).toContainEqual(
          expect.objectContaining({
            name: column,
            notnull: 1,
            dflt_value: "''",
          }),
        );
      }
      migratedDriver.close();
      await migrated.close();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("preserves legacy local-password users and hashes in generic provider storage", async () => {
    const rootPath = await mkdtemp(
      join(tmpdir(), "apinteract-auth-provider-migration-"),
    );
    const databasePath = join(rootPath, "apinteract.sqlite3");
    const backupDirectory = join(rootPath, "backups");
    try {
      const current = await SqliteDatabase.open(databasePath, backupDirectory);
      await current.close();
      const driver = new BetterSqlite3(databasePath);
      const userId = Buffer.alloc(16, 21);
      const credentialId = Buffer.alloc(16, 22);
      driver.exec(`
        DROP TABLE authentication_attempts;
        DROP TABLE provider_credential_lookup_keys;
        DROP TABLE provider_credential_material;
        DROP TABLE login_credentials;
        CREATE TABLE login_credentials (
          id BLOB PRIMARY KEY CHECK(length(id) = 16),
          user_id BLOB NOT NULL REFERENCES users(id),
          provider_id TEXT NOT NULL,
          provider_subject TEXT NOT NULL,
          secret_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
          created_at INTEGER NOT NULL,
          UNIQUE(provider_id, provider_subject)
        ) STRICT;
        CREATE INDEX login_credentials_user_id ON login_credentials(user_id);
        DELETE FROM schema_migrations WHERE id = '0019_auth_provider_credentials';
      `);
      driver
        .prepare(
          "INSERT INTO users VALUES (?, 'active', 'LegacyUser', 'Legacy User', 1, ?, NULL)",
        )
        .run(userId, Date.now());
      driver
        .prepare(
          "INSERT INTO login_credentials VALUES (?, ?, 'local-password', 'LegacyUser', 'encoded-hash', 'active', ?)",
        )
        .run(credentialId, userId, Date.now());
      driver.close();

      const migrated = await SqliteDatabase.open(databasePath, backupDirectory);
      const credential = await migrated.db
        .selectFrom("login_credentials as credential")
        .innerJoin(
          "provider_credential_material as material",
          "material.credential_id",
          "credential.id",
        )
        .innerJoin(
          "provider_credential_lookup_keys as lookup",
          "lookup.credential_id",
          "credential.id",
        )
        .select([
          "credential.user_id",
          "credential.provider_instance_id",
          "credential.provider_subject",
          "material.schema_version",
          "material.data_json",
          "lookup.key_name",
          "lookup.normalized_value",
        ])
        .executeTakeFirstOrThrow();
      expect(credential).toEqual({
        user_id: userId,
        provider_instance_id: "local-password",
        provider_subject: credentialId.toString("hex"),
        schema_version: 1,
        data_json: '{"passwordHash":"encoded-hash"}',
        key_name: "username",
        normalized_value: "legacyuser",
      });
      await migrated.close();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
