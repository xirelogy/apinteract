import { randomUUID } from "node:crypto";
import { chmod, mkdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import type { DatabaseSchema } from "./schema.js";

const INITIAL_MIGRATION = "0001_quick_verification";
const EXPANDED_REQUEST_MIGRATION = "0002_expanded_request_profile";
const TEMPORARY_EXECUTION_MIGRATION = "0003_temporary_executions";
const COLLECTION_PROFILES_MIGRATION = "0004_collection_profiles";
const ENVIRONMENTS_MIGRATION = "0005_environments";
const VARIABLE_SCOPES_MIGRATION = "0006_variable_scopes";
const WORKSPACE_HEADERS_MIGRATION = "0007_workspace_headers";
const REQUEST_SCRIPTS_MIGRATION = "0008_request_scripts";
const RESOURCE_DELETION_MIGRATION = "0009_resource_deletion";

const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE instance_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE users (
  id BLOB PRIMARY KEY CHECK(length(id) = 16),
  status TEXT NOT NULL CHECK(status IN ('active', 'deactivated', 'deleted')),
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  is_instance_admin INTEGER NOT NULL CHECK(is_instance_admin IN (0, 1)),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;

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

CREATE TABLE sessions (
  id BLOB PRIMARY KEY CHECK(length(id) = 16),
  user_id BLOB NOT NULL REFERENCES users(id),
  family_id BLOB NOT NULL CHECK(length(family_id) = 16),
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked', 'expired')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_user_status ON sessions(user_id, status);

CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id BLOB NOT NULL REFERENCES sessions(id),
  status TEXT NOT NULL CHECK(status IN ('active', 'consumed')),
  created_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX refresh_tokens_session ON refresh_tokens(session_id);

CREATE TABLE workspaces (
  id BLOB PRIMARY KEY CHECK(length(id) = 16),
  name TEXT NOT NULL,
  created_by BLOB NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE workspace_memberships (
  workspace_id BLOB NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id BLOB NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, user_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX workspace_memberships_user ON workspace_memberships(user_id);

CREATE TABLE workspace_tree_nodes (
  id BLOB PRIMARY KEY CHECK(length(id) = 16),
  workspace_id BLOB NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_collection_id BLOB REFERENCES workspace_tree_nodes(id),
  kind TEXT NOT NULL CHECK(kind IN ('collection', 'request')),
  position INTEGER NOT NULL CHECK(position >= 0),
  name TEXT NOT NULL,
  order_revision INTEGER NOT NULL DEFAULT 0 CHECK(order_revision >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE(workspace_id, parent_collection_id, position)
) STRICT;
CREATE INDEX workspace_tree_parent
  ON workspace_tree_nodes(workspace_id, parent_collection_id, position);

CREATE TABLE request_drafts (
  request_id BLOB PRIMARY KEY REFERENCES workspace_tree_nodes(id) ON DELETE CASCADE,
  draft_revision INTEGER NOT NULL CHECK(draft_revision >= 0),
  method TEXT NOT NULL CHECK(method = 'GET'),
  target_mode TEXT NOT NULL CHECK(target_mode = 'absolute'),
  target_url TEXT NOT NULL,
  query_mode TEXT NOT NULL CHECK(query_mode = 'structured'),
  updated_by BLOB NOT NULL REFERENCES users(id),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE request_revisions (
  id BLOB PRIMARY KEY CHECK(length(id) = 16),
  request_id BLOB NOT NULL REFERENCES request_drafts(request_id),
  parent_revision_id BLOB REFERENCES request_revisions(id),
  creation_reason TEXT NOT NULL CHECK(creation_reason IN ('manual_save', 'execution')),
  created_by BLOB NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL
) STRICT;
CREATE INDEX request_revisions_request_created
  ON request_revisions(request_id, created_at DESC, id DESC);

CREATE TABLE blobs (
  id BLOB PRIMARY KEY CHECK(length(id) = 16),
  provider_id TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('available', 'partial', 'missing')),
  purpose TEXT NOT NULL CHECK(purpose = 'execution_response'),
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE executions (
  id BLOB PRIMARY KEY CHECK(length(id) = 16),
  request_id BLOB NOT NULL REFERENCES request_drafts(request_id),
  request_revision_id BLOB NOT NULL REFERENCES request_revisions(id),
  created_by BLOB NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK(state IN ('created', 'running', 'completed', 'failed')),
  snapshot_json TEXT NOT NULL,
  response_status INTEGER,
  response_headers_json TEXT,
  response_blob_id BLOB REFERENCES blobs(id),
  body_complete INTEGER NOT NULL CHECK(body_complete IN (0, 1)),
  body_bytes INTEGER,
  body_sha256 TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;
CREATE INDEX executions_request_created
  ON executions(request_id, created_at DESC, id DESC);

CREATE TABLE blob_references (
  blob_id BLOB NOT NULL REFERENCES blobs(id),
  owner_kind TEXT NOT NULL CHECK(owner_kind = 'execution_response'),
  owner_id BLOB NOT NULL REFERENCES executions(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(blob_id, owner_kind, owner_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE audit_outbox (
  id BLOB PRIMARY KEY CHECK(length(id) = 16),
  event_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  published_at INTEGER
) STRICT;
CREATE INDEX audit_outbox_unpublished
  ON audit_outbox(published_at, occurred_at, id);

CREATE TABLE audit_segments (
  id BLOB PRIMARY KEY CHECK(length(id) = 16),
  storage_path TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('open', 'closed')),
  byte_length INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
) STRICT;

CREATE TABLE audit_event_index (
  event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
  event_type TEXT NOT NULL,
  actor_user_id BLOB REFERENCES users(id),
  workspace_id BLOB REFERENCES workspaces(id),
  segment_id BLOB NOT NULL REFERENCES audit_segments(id),
  occurred_at INTEGER NOT NULL
) STRICT;
CREATE INDEX audit_event_workspace_time
  ON audit_event_index(workspace_id, occurred_at DESC, event_id DESC);
`;

/**
 * SQLite persistence adapter and automatic schema-migration boundary.
 *
 * SQLite-specific pragmas and migration SQL stay here so domain services use
 * only the database-neutral Kysely contract.
 */
export class SqliteDatabase {
  readonly db: Kysely<DatabaseSchema>;
  readonly #driver: BetterSqlite3.Database;

  private constructor(driver: BetterSqlite3.Database) {
    this.#driver = driver;
    this.db = new Kysely<DatabaseSchema>({
      dialect: new SqliteDialect({ database: driver }),
    });
  }

  /** Opens the SQLite database, configures durability, and applies migrations. */
  static async open(
    path: string,
    migrationBackupDirectory = join(dirname(path), "backups"),
  ): Promise<SqliteDatabase> {
    const existingDatabase = await nonEmptyFile(path);
    await mkdir(dirname(path), { recursive: true });
    const driver = new BetterSqlite3(path);
    // These settings provide referential enforcement, durable commits, bounded
    // lock waiting, and safer handling of schema objects for the local store.
    driver.pragma("foreign_keys = ON");
    driver.pragma("journal_mode = WAL");
    driver.pragma("synchronous = FULL");
    driver.pragma("busy_timeout = 5000");
    driver.pragma("trusted_schema = OFF");
    try {
      const database = new SqliteDatabase(driver);
      const migrationsPending =
        !database.#migrationLedgerExists() || database.#hasPendingMigrations();
      if (existingDatabase && migrationsPending) {
        await mkdir(migrationBackupDirectory, {
          recursive: true,
          mode: 0o700,
        });
        const stem = basename(path, extname(path));
        const backupPath = join(
          migrationBackupDirectory,
          `${stem}-before-migration-${Date.now()}-${randomUUID()}.sqlite3`,
        );
        // better-sqlite3's online backup API includes committed WAL content,
        // producing one consistent recovery file before schema changes begin.
        await driver.backup(backupPath);
        await chmod(backupPath, 0o600);
      }
      database.#ensureMigrationLedger();
      database.#migrate();
      return database;
    } catch (cause) {
      driver.close();
      throw cause;
    }
  }

  /** Closes the Kysely connection and its underlying SQLite driver. */
  async close(): Promise<void> {
    await this.db.destroy();
  }

  /** Applies the initial schema exactly once within a SQLite transaction. */
  #migrate(): void {
    const initialApplied = this.#driver
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(INITIAL_MIGRATION);
    if (initialApplied === undefined) {
      this.#driver.transaction(() => {
        this.#driver.exec(INITIAL_SCHEMA_SQL);
        this.#recordMigration(INITIAL_MIGRATION);
      })();
    }

    const expandedRequestApplied = this.#driver
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(EXPANDED_REQUEST_MIGRATION);
    if (expandedRequestApplied === undefined) {
      this.#migrateExpandedRequestProfile();
    }

    const temporaryExecutionApplied = this.#driver
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(TEMPORARY_EXECUTION_MIGRATION);
    if (temporaryExecutionApplied === undefined) {
      this.#migrateTemporaryExecutions();
    }

    const collectionProfilesApplied = this.#driver
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(COLLECTION_PROFILES_MIGRATION);
    if (collectionProfilesApplied === undefined) {
      this.#migrateCollectionProfiles();
    }

    const environmentsApplied = this.#driver
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(ENVIRONMENTS_MIGRATION);
    if (environmentsApplied === undefined) {
      this.#migrateEnvironments();
    }

    const variableScopesApplied = this.#driver
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(VARIABLE_SCOPES_MIGRATION);
    if (variableScopesApplied === undefined) {
      this.#migrateVariableScopes();
    }

    const workspaceHeadersApplied = this.#driver
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(WORKSPACE_HEADERS_MIGRATION);
    if (workspaceHeadersApplied === undefined) {
      this.#migrateWorkspaceHeaders();
    }

    const requestScriptsApplied = this.#driver
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(REQUEST_SCRIPTS_MIGRATION);
    if (requestScriptsApplied === undefined) {
      this.#migrateRequestScripts();
    }

    const resourceDeletionApplied = this.#driver
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(RESOURCE_DELETION_MIGRATION);
    if (resourceDeletionApplied === undefined) {
      this.#migrateResourceDeletion();
    }
  }

  /** Creates the ledger required to inspect migration state safely. */
  #ensureMigrationLedger(): void {
    this.#driver.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
  }

  /** Reports whether the database has entered APInteract migration governance. */
  #migrationLedgerExists(): boolean {
    return (
      this.#driver
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        )
        .get() !== undefined
    );
  }

  /** Reports whether this release would modify the existing physical schema. */
  #hasPendingMigrations(): boolean {
    const applied = this.#driver
      .prepare("SELECT id FROM schema_migrations")
      .all() as { readonly id: string }[];
    const identifiers = new Set(applied.map((migration) => migration.id));
    return [
      INITIAL_MIGRATION,
      EXPANDED_REQUEST_MIGRATION,
      TEMPORARY_EXECUTION_MIGRATION,
      COLLECTION_PROFILES_MIGRATION,
      ENVIRONMENTS_MIGRATION,
      VARIABLE_SCOPES_MIGRATION,
      WORKSPACE_HEADERS_MIGRATION,
      REQUEST_SCRIPTS_MIGRATION,
      RESOURCE_DELETION_MIGRATION,
    ].some((identifier) => !identifiers.has(identifier));
  }

  /** Rebuilds GET-only drafts with expanded request content columns. */
  #migrateExpandedRequestProfile(): void {
    this.#driver.pragma("foreign_keys = OFF");
    try {
      this.#driver.transaction(() => {
        this.#driver.exec(`
          CREATE TABLE request_drafts_expanded (
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
            updated_at INTEGER NOT NULL
          ) STRICT;

          INSERT INTO request_drafts_expanded (
            request_id,
            draft_revision,
            method,
            target_mode,
            target_url,
            query_mode,
            query_json,
            headers_json,
            body_text,
            updated_by,
            updated_at
          )
          SELECT
            request_id,
            draft_revision,
            method,
            target_mode,
            target_url,
            query_mode,
            '[]',
            '[]',
            '',
            updated_by,
            updated_at
          FROM request_drafts;

          DROP TABLE request_drafts;
          ALTER TABLE request_drafts_expanded RENAME TO request_drafts;
        `);
        this.#recordMigration(EXPANDED_REQUEST_MIGRATION);
      })();
    } finally {
      this.#driver.pragma("foreign_keys = ON");
    }
    const violation = this.#driver.prepare("PRAGMA foreign_key_check").get();
    if (violation !== undefined) {
      throw new Error("Expanded request migration violated a foreign key");
    }
  }

  /** Adds direct workspace ownership and optional saved-request references. */
  #migrateTemporaryExecutions(): void {
    this.#driver.pragma("foreign_keys = OFF");
    try {
      this.#driver.transaction(() => {
        this.#driver.exec(`
          CREATE TABLE executions_temporary (
            id BLOB PRIMARY KEY CHECK(length(id) = 16),
            workspace_id BLOB NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            request_id BLOB REFERENCES request_drafts(request_id),
            request_revision_id BLOB REFERENCES request_revisions(id),
            created_by BLOB NOT NULL REFERENCES users(id),
            state TEXT NOT NULL CHECK(state IN ('created', 'running', 'completed', 'failed')),
            snapshot_json TEXT NOT NULL,
            response_status INTEGER,
            response_headers_json TEXT,
            response_blob_id BLOB REFERENCES blobs(id),
            body_complete INTEGER NOT NULL CHECK(body_complete IN (0, 1)),
            body_bytes INTEGER,
            body_sha256 TEXT,
            error_json TEXT,
            created_at INTEGER NOT NULL,
            completed_at INTEGER,
            CHECK (
              (request_id IS NULL AND request_revision_id IS NULL) OR
              (request_id IS NOT NULL AND request_revision_id IS NOT NULL)
            )
          ) STRICT;

          INSERT INTO executions_temporary (
            id,
            workspace_id,
            request_id,
            request_revision_id,
            created_by,
            state,
            snapshot_json,
            response_status,
            response_headers_json,
            response_blob_id,
            body_complete,
            body_bytes,
            body_sha256,
            error_json,
            created_at,
            completed_at
          )
          SELECT
            execution.id,
            node.workspace_id,
            execution.request_id,
            execution.request_revision_id,
            execution.created_by,
            execution.state,
            execution.snapshot_json,
            execution.response_status,
            execution.response_headers_json,
            execution.response_blob_id,
            execution.body_complete,
            execution.body_bytes,
            execution.body_sha256,
            execution.error_json,
            execution.created_at,
            execution.completed_at
          FROM executions AS execution
          INNER JOIN workspace_tree_nodes AS node
            ON node.id = execution.request_id;

          DROP TABLE executions;
          ALTER TABLE executions_temporary RENAME TO executions;
          CREATE INDEX executions_request_created
            ON executions(request_id, created_at DESC, id DESC);
          CREATE INDEX executions_workspace_created
            ON executions(workspace_id, created_at DESC, id DESC);
        `);
        this.#recordMigration(TEMPORARY_EXECUTION_MIGRATION);
      })();
    } finally {
      this.#driver.pragma("foreign_keys = ON");
    }
    const violation = this.#driver.prepare("PRAGMA foreign_key_check").get();
    if (violation !== undefined) {
      throw new Error("Temporary execution migration violated a foreign key");
    }
  }

  /** Adds optimistic collection-owned request header profiles. */
  #migrateCollectionProfiles(): void {
    this.#driver.transaction(() => {
      this.#driver.exec(`
        CREATE TABLE collection_profiles (
          collection_id BLOB PRIMARY KEY REFERENCES workspace_tree_nodes(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK(revision >= 0),
          headers_json TEXT NOT NULL,
          updated_by BLOB NOT NULL REFERENCES users(id),
          updated_at INTEGER NOT NULL
        ) STRICT;
      `);
      this.#recordMigration(COLLECTION_PROFILES_MIGRATION);
    })();
  }

  /** Adds workspace environments, variable profiles, secrets, and selections. */
  #migrateEnvironments(): void {
    this.#driver.transaction(() => {
      this.#driver.exec(`
        CREATE TABLE environments (
          id BLOB PRIMARY KEY CHECK(length(id) = 16),
          workspace_id BLOB NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          name_key TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 0),
          created_by BLOB NOT NULL REFERENCES users(id),
          created_at INTEGER NOT NULL,
          updated_by BLOB NOT NULL REFERENCES users(id),
          updated_at INTEGER NOT NULL,
          UNIQUE(workspace_id, name_key)
        ) STRICT;
        CREATE INDEX environments_workspace_created
          ON environments(workspace_id, created_at, id);

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

        CREATE TABLE session_workspace_environments (
          session_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          workspace_id BLOB NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          selected_environment_id BLOB NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(session_id, workspace_id)
        ) WITHOUT ROWID, STRICT;
        CREATE INDEX session_workspace_environments_environment
          ON session_workspace_environments(selected_environment_id);
      `);
      this.#recordMigration(ENVIRONMENTS_MIGRATION);
    })();
  }

  /** Generalizes environment variables into revisioned persisted scope profiles. */
  #migrateVariableScopes(): void {
    this.#driver.transaction(() => {
      this.#driver.exec(`
        CREATE TABLE variable_profiles (
          id BLOB PRIMARY KEY CHECK(length(id) = 16),
          workspace_id BLOB NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          scope_kind TEXT NOT NULL CHECK(scope_kind IN ('workspace', 'collection', 'environment', 'request')),
          scope_id BLOB NOT NULL CHECK(length(scope_id) = 16),
          revision INTEGER NOT NULL CHECK(revision >= 0),
          updated_by BLOB NOT NULL REFERENCES users(id),
          updated_at INTEGER NOT NULL,
          UNIQUE(scope_kind, scope_id)
        ) STRICT;
        CREATE INDEX variable_profiles_workspace
          ON variable_profiles(workspace_id, scope_kind, scope_id);

        CREATE TABLE variables (
          id BLOB PRIMARY KEY CHECK(length(id) = 16),
          profile_id BLOB NOT NULL REFERENCES variable_profiles(id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK(position >= 0),
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('value', 'secret', 'alias', 'unset')),
          value_text TEXT,
          alias_target TEXT,
          UNIQUE(profile_id, position),
          UNIQUE(profile_id, name),
          CHECK (
            (kind = 'value' AND value_text IS NOT NULL AND alias_target IS NULL) OR
            (kind = 'alias' AND value_text IS NULL AND alias_target IS NOT NULL) OR
            (kind IN ('secret', 'unset') AND value_text IS NULL AND alias_target IS NULL)
          )
        ) STRICT;
        CREATE INDEX variables_profile ON variables(profile_id, position);

        CREATE TABLE variable_secrets (
          variable_id BLOB PRIMARY KEY REFERENCES variables(id) ON DELETE CASCADE,
          version INTEGER NOT NULL CHECK(version >= 1),
          storage_format TEXT NOT NULL CHECK(storage_format = 'plaintext-v1'),
          payload TEXT
        ) STRICT;

        INSERT INTO variable_profiles (
          id, workspace_id, scope_kind, scope_id, revision, updated_by, updated_at
        )
        SELECT id, workspace_id, 'environment', id, revision, updated_by, updated_at
        FROM environments;

        INSERT INTO variables (
          id, profile_id, position, name, kind, value_text, alias_target
        )
        SELECT id, environment_id, position, name, kind, value_text, alias_target
        FROM environment_variables;

        INSERT INTO variable_secrets (variable_id, version, storage_format, payload)
        SELECT variable_id, version, storage_format, payload
        FROM environment_variable_secrets;

        DROP TABLE environment_variable_secrets;
        DROP TABLE environment_variables;
      `);
      this.#recordMigration(VARIABLE_SCOPES_MIGRATION);
    })();
  }

  /** Adds revisioned common headers to the workspace inheritance root. */
  #migrateWorkspaceHeaders(): void {
    this.#driver.transaction(() => {
      this.#driver.exec(`
        ALTER TABLE workspaces
          ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0);
        ALTER TABLE workspaces
          ADD COLUMN headers_json TEXT NOT NULL DEFAULT '[]';
      `);
      this.#recordMigration(WORKSPACE_HEADERS_MIGRATION);
    })();
  }

  /** Adds request-phase JavaScript sources and persisted execution results. */
  #migrateRequestScripts(): void {
    this.#driver.transaction(() => {
      this.#driver.exec(`
        ALTER TABLE request_drafts
          ADD COLUMN pre_request_script TEXT NOT NULL DEFAULT '';
        ALTER TABLE request_drafts
          ADD COLUMN post_response_script TEXT NOT NULL DEFAULT '';
        ALTER TABLE executions
          ADD COLUMN script_result_json TEXT;
      `);
      this.#recordMigration(REQUEST_SCRIPTS_MIGRATION);
    })();
  }

  /** Adds workspace tombstone ownership for history-preserving deletion. */
  #migrateResourceDeletion(): void {
    this.#driver.transaction(() => {
      this.#driver.exec(`
        ALTER TABLE workspaces
          ADD COLUMN deleted_by BLOB REFERENCES users(id);
        ALTER TABLE workspaces
          ADD COLUMN deleted_at INTEGER;
      `);
      this.#recordMigration(RESOURCE_DELETION_MIGRATION);
    })();
  }

  /** Records one successfully applied schema migration. */
  #recordMigration(id: string): void {
    this.#driver
      .prepare("INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)")
      .run(id, Date.now());
  }
}

/** Reports whether a path identifies an existing database with stored bytes. */
async function nonEmptyFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw cause;
  }
}
