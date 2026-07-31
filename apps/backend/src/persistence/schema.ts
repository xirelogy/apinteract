import type { Generated } from "kysely";

export type BinaryId = Uint8Array;

export interface InstanceMetadataTable {
  key: string;
  value: string;
}

export interface UserTable {
  id: BinaryId;
  status: "active" | "deactivated" | "deleted";
  username: string;
  display_name: string;
  is_instance_admin: 0 | 1;
  created_at: number;
  deleted_at: number | null;
}

export interface LoginCredentialTable {
  id: BinaryId;
  user_id: BinaryId;
  provider_id: string;
  provider_subject: string;
  secret_hash: string;
  status: "active" | "disabled";
  created_at: number;
}

export interface SessionTable {
  id: BinaryId;
  user_id: BinaryId;
  family_id: BinaryId;
  status: "active" | "revoked" | "expired";
  created_at: number;
  last_seen_at: number;
  absolute_expires_at: number;
}

export interface RefreshTokenTable {
  token_hash: string;
  session_id: BinaryId;
  status: "active" | "consumed";
  created_at: number;
  idle_expires_at: number;
}

export interface WorkspaceTable {
  id: BinaryId;
  name: string;
  created_by: BinaryId;
  created_at: number;
}

export interface WorkspaceMembershipTable {
  workspace_id: BinaryId;
  user_id: BinaryId;
  role: "owner" | "editor" | "viewer";
  created_at: number;
}

export interface WorkspaceTreeNodeTable {
  id: BinaryId;
  workspace_id: BinaryId;
  parent_collection_id: BinaryId | null;
  kind: "collection" | "request";
  position: number;
  name: string;
  order_revision: number;
  created_at: number;
}

export interface CollectionProfileTable {
  collection_id: BinaryId;
  revision: number;
  headers_json: string;
  updated_by: BinaryId;
  updated_at: number;
}

export interface EnvironmentTable {
  id: BinaryId;
  workspace_id: BinaryId;
  name: string;
  name_key: string;
  revision: number;
  created_by: BinaryId;
  created_at: number;
  updated_by: BinaryId;
  updated_at: number;
}

export interface VariableProfileTable {
  id: BinaryId;
  workspace_id: BinaryId;
  scope_kind: "workspace" | "collection" | "environment" | "request";
  scope_id: BinaryId;
  revision: number;
  updated_by: BinaryId;
  updated_at: number;
}

export interface VariableTable {
  id: BinaryId;
  profile_id: BinaryId;
  position: number;
  name: string;
  kind: "value" | "secret" | "alias" | "unset";
  value_text: string | null;
  alias_target: string | null;
}

export interface VariableSecretTable {
  variable_id: BinaryId;
  version: number;
  storage_format: "plaintext-v1";
  payload: string | null;
}

export interface SessionWorkspaceEnvironmentTable {
  session_id: BinaryId;
  workspace_id: BinaryId;
  selected_environment_id: BinaryId;
  updated_at: number;
}

export interface RequestDraftTable {
  request_id: BinaryId;
  draft_revision: number;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  target_mode: "absolute";
  target_url: string;
  query_mode: "structured";
  query_json: string;
  headers_json: string;
  body_text: string;
  updated_by: BinaryId;
  updated_at: number;
}

export interface RequestRevisionTable {
  id: BinaryId;
  request_id: BinaryId;
  parent_revision_id: BinaryId | null;
  creation_reason: "manual_save" | "execution";
  created_by: BinaryId;
  created_at: number;
  content_json: string;
  content_fingerprint: string;
}

export interface ExecutionTable {
  id: BinaryId;
  workspace_id: BinaryId;
  request_id: BinaryId | null;
  request_revision_id: BinaryId | null;
  created_by: BinaryId;
  state: "created" | "running" | "completed" | "failed";
  snapshot_json: string;
  response_status: number | null;
  response_headers_json: string | null;
  response_blob_id: BinaryId | null;
  body_complete: 0 | 1;
  body_bytes: number | null;
  body_sha256: string | null;
  error_json: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface BlobTable {
  id: BinaryId;
  provider_id: string;
  storage_key: string;
  state: "available" | "partial" | "missing";
  purpose: "execution_response";
  byte_length: number;
  sha256: string;
  created_at: number;
}

export interface BlobReferenceTable {
  blob_id: BinaryId;
  owner_kind: "execution_response";
  owner_id: BinaryId;
  created_at: number;
}

export interface AuditOutboxTable {
  id: BinaryId;
  event_json: string;
  occurred_at: number;
  published_at: number | null;
}

export interface AuditEventIndexTable {
  event_id: BinaryId;
  event_type: string;
  actor_user_id: BinaryId | null;
  workspace_id: BinaryId | null;
  segment_id: BinaryId;
  occurred_at: number;
}

export interface AuditSegmentTable {
  id: BinaryId;
  storage_path: string;
  state: "open" | "closed";
  byte_length: Generated<number>;
  created_at: number;
  closed_at: number | null;
}

export interface MigrationTable {
  id: string;
  applied_at: number;
}

export interface DatabaseSchema {
  instance_metadata: InstanceMetadataTable;
  users: UserTable;
  login_credentials: LoginCredentialTable;
  sessions: SessionTable;
  refresh_tokens: RefreshTokenTable;
  workspaces: WorkspaceTable;
  workspace_memberships: WorkspaceMembershipTable;
  workspace_tree_nodes: WorkspaceTreeNodeTable;
  collection_profiles: CollectionProfileTable;
  environments: EnvironmentTable;
  variable_profiles: VariableProfileTable;
  variables: VariableTable;
  variable_secrets: VariableSecretTable;
  session_workspace_environments: SessionWorkspaceEnvironmentTable;
  request_drafts: RequestDraftTable;
  request_revisions: RequestRevisionTable;
  executions: ExecutionTable;
  blobs: BlobTable;
  blob_references: BlobReferenceTable;
  audit_outbox: AuditOutboxTable;
  audit_event_index: AuditEventIndexTable;
  audit_segments: AuditSegmentTable;
  schema_migrations: MigrationTable;
}
