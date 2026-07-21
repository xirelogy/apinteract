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

export interface WorkspaceSummary {
  readonly workspaceId: EntityId;
  readonly name: string;
  readonly role: "owner" | "editor" | "viewer";
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
