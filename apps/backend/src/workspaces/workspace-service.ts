import type { Kysely, Transaction } from "kysely";

import type { AuditService } from "../audit/audit-service.js";
import {
  bytesToId,
  createEntityId,
  idToBytes,
  type EntityId,
} from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";

export class AccessDeniedError extends Error {}
export class ResourceNotFoundError extends Error {}
export class WorkspaceConflictError extends Error {}

export interface WorkspaceHeader {
  readonly name: string;
  readonly value: string;
  readonly enabled: boolean;
}

export interface WorkspaceSummary {
  readonly workspaceId: EntityId;
  readonly name: string;
  readonly role: "owner" | "editor" | "viewer";
}

export interface WorkspaceView extends WorkspaceSummary {
  readonly headers: readonly WorkspaceHeader[];
  readonly revision: number;
}

/**
 * Owns workspace membership and role-based authorization.
 *
 * Other domain services call these guards inside their active transaction so
 * authorization is checked against the same database state they modify.
 */
export class WorkspaceService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #audit: AuditService;

  constructor(database: Kysely<DatabaseSchema>, audit: AuditService) {
    this.#database = database;
    this.#audit = audit;
  }

  /** Creates a workspace and assigns its creator the owner role atomically. */
  async create(userId: EntityId, name: string): Promise<WorkspaceSummary> {
    const workspaceId = createEntityId();
    const now = Date.now();
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("workspaces")
        .values({
          id: idToBytes(workspaceId),
          name: normalizeName(name),
          revision: 0,
          headers_json: "[]",
          created_by: idToBytes(userId),
          created_at: now,
        })
        .execute();
      await transaction
        .insertInto("workspace_memberships")
        .values({
          workspace_id: idToBytes(workspaceId),
          user_id: idToBytes(userId),
          role: "owner",
          created_at: now,
        })
        .execute();
      await this.#audit.record(transaction, {
        type: "workspace.created",
        actorUserId: userId,
        workspaceId,
        data: { name: normalizeName(name) },
      });
    });
    return { workspaceId, name: normalizeName(name), role: "owner" };
  }

  /** Loads workspace properties after concealing non-member workspaces. */
  async get(userId: EntityId, workspaceId: EntityId): Promise<WorkspaceView> {
    const row = await this.#database
      .selectFrom("workspaces as workspace")
      .innerJoin(
        "workspace_memberships as membership",
        "membership.workspace_id",
        "workspace.id",
      )
      .select([
        "workspace.id",
        "workspace.name",
        "workspace.revision",
        "workspace.headers_json",
        "membership.role",
      ])
      .where("workspace.id", "=", idToBytes(workspaceId))
      .where("membership.user_id", "=", idToBytes(userId))
      .executeTakeFirst();
    if (row === undefined) {
      throw new ResourceNotFoundError("Workspace not found");
    }
    return {
      workspaceId: bytesToId(row.id),
      name: row.name,
      role: row.role,
      headers: parseWorkspaceHeaders(row.headers_json),
      revision: row.revision,
    };
  }

  /** Replaces a workspace's display name and root common headers atomically. */
  async update(
    userId: EntityId,
    workspaceId: EntityId,
    expectedRevision: number,
    name: string,
    headers: readonly WorkspaceHeader[],
  ): Promise<WorkspaceView> {
    const normalizedName = normalizeName(name);
    const normalizedHeaders = validateWorkspaceHeaders(headers);
    return this.#database.transaction().execute(async (transaction) => {
      await this.requireCanEdit(transaction, userId, workspaceId);
      const row = await transaction
        .selectFrom("workspaces")
        .select(["name", "revision", "headers_json"])
        .where("id", "=", idToBytes(workspaceId))
        .executeTakeFirst();
      if (row === undefined) {
        throw new ResourceNotFoundError("Workspace not found");
      }
      if (row.revision !== expectedRevision) {
        throw new WorkspaceConflictError("The workspace properties changed");
      }
      const headersJson = JSON.stringify(normalizedHeaders);
      const membership = await transaction
        .selectFrom("workspace_memberships")
        .select("role")
        .where("workspace_id", "=", idToBytes(workspaceId))
        .where("user_id", "=", idToBytes(userId))
        .executeTakeFirstOrThrow();
      if (row.name === normalizedName && row.headers_json === headersJson) {
        return {
          workspaceId,
          name: normalizedName,
          role: membership.role,
          headers: normalizedHeaders,
          revision: row.revision,
        };
      }
      const revision = row.revision + 1;
      const result = await transaction
        .updateTable("workspaces")
        .set({ name: normalizedName, headers_json: headersJson, revision })
        .where("id", "=", idToBytes(workspaceId))
        .where("revision", "=", expectedRevision)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) {
        throw new WorkspaceConflictError("The workspace properties changed");
      }
      await this.#audit.record(transaction, {
        type: "workspace.updated",
        actorUserId: userId,
        workspaceId,
        data: {
          revision,
          nameChanged: row.name !== normalizedName,
          headersChanged: row.headers_json !== headersJson,
        },
      });
      return {
        workspaceId,
        name: normalizedName,
        role: membership.role,
        headers: normalizedHeaders,
        revision,
      };
    });
  }

  /** Lists workspaces visible through the user's current memberships. */
  async list(userId: EntityId): Promise<readonly WorkspaceSummary[]> {
    const rows = await this.#database
      .selectFrom("workspace_memberships as membership")
      .innerJoin(
        "workspaces as workspace",
        "workspace.id",
        "membership.workspace_id",
      )
      .select(["workspace.id", "workspace.name", "membership.role"])
      .where("membership.user_id", "=", idToBytes(userId))
      .orderBy("workspace.created_at")
      .orderBy("workspace.id")
      .execute();
    return rows.map((row) => ({
      workspaceId: bytesToId(row.id),
      name: row.name,
      role: row.role,
    }));
  }

  /** Requires owner or editor membership using the caller's database context. */
  async requireCanEdit(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    userId: EntityId,
    workspaceId: EntityId,
  ): Promise<void> {
    const membership = await database
      .selectFrom("workspace_memberships")
      .select("role")
      .where("workspace_id", "=", idToBytes(workspaceId))
      .where("user_id", "=", idToBytes(userId))
      .executeTakeFirst();
    if (
      membership === undefined ||
      (membership.role !== "owner" && membership.role !== "editor")
    ) {
      throw new AccessDeniedError("Workspace edit capability is required");
    }
  }

  /** Requires any workspace membership while concealing foreign workspaces. */
  async requireCanRead(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    userId: EntityId,
    workspaceId: EntityId,
  ): Promise<void> {
    const membership = await database
      .selectFrom("workspace_memberships")
      .select("role")
      .where("workspace_id", "=", idToBytes(workspaceId))
      .where("user_id", "=", idToBytes(userId))
      .executeTakeFirst();
    if (membership === undefined) {
      // Read operations conceal whether a workspace exists when the user has
      // no membership, avoiding an identifier-existence side channel.
      throw new ResourceNotFoundError("Workspace not found");
    }
  }
}

/** Trims and validates a user-facing workspace or tree-node name. */
export function normalizeName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new Error("Name must contain between 1 and 200 characters");
  }
  return normalized;
}

/** Validates workspace headers before persistence or inheritance resolution. */
function validateWorkspaceHeaders(
  headers: readonly WorkspaceHeader[],
): WorkspaceHeader[] {
  if (headers.length > 200) {
    throw new Error("Too many workspace headers");
  }
  return headers.map((header) => {
    if (
      typeof header.name !== "string" ||
      typeof header.value !== "string" ||
      typeof header.enabled !== "boolean" ||
      header.name.length > 1024 ||
      header.value.length > 16_384 ||
      (header.enabled && header.name.trim().length === 0)
    ) {
      throw new Error("Invalid workspace header");
    }
    return { ...header };
  });
}

/** Parses only values that satisfy the workspace header persistence contract. */
function parseWorkspaceHeaders(value: string): WorkspaceHeader[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid persisted workspace headers");
  }
  return validateWorkspaceHeaders(parsed as WorkspaceHeader[]);
}
