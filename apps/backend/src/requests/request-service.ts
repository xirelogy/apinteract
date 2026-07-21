import { createHash } from "node:crypto";

import type { Kysely, Transaction } from "kysely";

import type { AuditService } from "../audit/audit-service.js";
import {
  bytesToId,
  createEntityId,
  idToBytes,
  type EntityId,
} from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";
import {
  normalizeName,
  ResourceNotFoundError,
} from "../workspaces/workspace-service.js";

export interface TreeNodeView {
  readonly nodeId: EntityId;
  readonly kind: "collection" | "request";
  readonly name: string;
  readonly position: number;
}

export interface RequestView {
  readonly requestId: EntityId;
  readonly workspaceId: EntityId;
  readonly name: string;
  readonly method: "GET";
  readonly targetMode: "absolute";
  readonly targetUrl: string;
  readonly queryMode: "structured";
  readonly draftRevision: number;
}

export interface PreparedExecution {
  readonly executionId: EntityId;
  readonly revisionId: EntityId;
  readonly request: RequestView;
  readonly createdAt: number;
}

/** Raised when an update targets a stale persisted draft revision. */
export class DraftConflictError extends Error {}

/**
 * Owns the ordered collection/request tree and mutable request drafts.
 *
 * Draft edits use optimistic revision checks. Executions reference immutable
 * request revisions, creating one only when current draft content has changed.
 */
export class RequestService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #workspaces: WorkspaceService;
  readonly #audit: AuditService;

  constructor(
    database: Kysely<DatabaseSchema>,
    workspaces: WorkspaceService,
    audit: AuditService,
  ) {
    this.#database = database;
    this.#workspaces = workspaces;
    this.#audit = audit;
  }

  /** Lists ordered collection and request children under one authorized parent. */
  async listChildren(
    userId: EntityId,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
  ): Promise<readonly TreeNodeView[]> {
    await this.#workspaces.requireCanRead(this.#database, userId, workspaceId);
    const query = this.#database
      .selectFrom("workspace_tree_nodes")
      .select(["id", "kind", "name", "position"])
      .where("workspace_id", "=", idToBytes(workspaceId));
    const rows =
      parentCollectionId === null
        ? await query
            .where("parent_collection_id", "is", null)
            .orderBy("position")
            .execute()
        : await query
            .where("parent_collection_id", "=", idToBytes(parentCollectionId))
            .orderBy("position")
            .execute();
    return rows.map((row) => ({
      nodeId: bytesToId(row.id),
      kind: row.kind,
      name: row.name,
      position: row.position,
    }));
  }

  /** Appends a collection to an authorized workspace parent. */
  async createCollection(
    userId: EntityId,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
    name: string,
  ): Promise<TreeNodeView> {
    return this.#database.transaction().execute(async (transaction) => {
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      await this.#validateParent(transaction, workspaceId, parentCollectionId);
      const position = await this.#nextPosition(
        transaction,
        workspaceId,
        parentCollectionId,
      );
      const nodeId = createEntityId();
      await transaction
        .insertInto("workspace_tree_nodes")
        .values({
          id: idToBytes(nodeId),
          workspace_id: idToBytes(workspaceId),
          parent_collection_id:
            parentCollectionId === null ? null : idToBytes(parentCollectionId),
          kind: "collection",
          position,
          name: normalizeName(name),
          order_revision: 0,
          created_at: Date.now(),
        })
        .execute();
      await this.#audit.record(transaction, {
        type: "collection.created",
        actorUserId: userId,
        workspaceId,
        data: { collectionId: nodeId, parentCollectionId },
      });
      return {
        nodeId,
        kind: "collection",
        name: normalizeName(name),
        position,
      };
    });
  }

  /** Appends a request draft to an authorized workspace parent. */
  async createRequest(
    userId: EntityId,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
    name: string,
    targetUrl: string,
  ): Promise<RequestView> {
    const normalizedUrl = validateTargetUrl(targetUrl);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      await this.#validateParent(transaction, workspaceId, parentCollectionId);
      const position = await this.#nextPosition(
        transaction,
        workspaceId,
        parentCollectionId,
      );
      const requestId = createEntityId();
      const now = Date.now();
      await transaction
        .insertInto("workspace_tree_nodes")
        .values({
          id: idToBytes(requestId),
          workspace_id: idToBytes(workspaceId),
          parent_collection_id:
            parentCollectionId === null ? null : idToBytes(parentCollectionId),
          kind: "request",
          position,
          name: normalizeName(name),
          order_revision: 0,
          created_at: now,
        })
        .execute();
      await transaction
        .insertInto("request_drafts")
        .values({
          request_id: idToBytes(requestId),
          draft_revision: 0,
          method: "GET",
          target_mode: "absolute",
          target_url: normalizedUrl,
          query_mode: "structured",
          updated_by: idToBytes(userId),
          updated_at: now,
        })
        .execute();
      await this.#audit.record(transaction, {
        type: "request.created",
        actorUserId: userId,
        workspaceId,
        data: { requestId, parentCollectionId },
      });
      return {
        requestId,
        workspaceId,
        name: normalizeName(name),
        method: "GET",
        targetMode: "absolute",
        targetUrl: normalizedUrl,
        queryMode: "structured",
        draftRevision: 0,
      };
    });
  }

  /** Loads one request draft after verifying workspace visibility. */
  async get(userId: EntityId, requestId: EntityId): Promise<RequestView> {
    const row = await this.#requestRow(this.#database, requestId);
    await this.#workspaces.requireCanRead(
      this.#database,
      userId,
      bytesToId(row.workspace_id),
    );
    return mapRequest(row);
  }

  /** Updates a request draft only when its expected revision is current. */
  async update(
    userId: EntityId,
    requestId: EntityId,
    expectedDraftRevision: number,
    name: string,
    targetUrl: string,
  ): Promise<RequestView> {
    const normalizedUrl = validateTargetUrl(targetUrl);
    return this.#database.transaction().execute(async (transaction) => {
      const row = await this.#requestRow(transaction, requestId);
      const workspaceId = bytesToId(row.workspace_id);
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      if (row.draft_revision !== expectedDraftRevision) {
        throw new DraftConflictError("The request draft changed");
      }
      await transaction
        .updateTable("workspace_tree_nodes")
        .set({ name: normalizeName(name) })
        .where("id", "=", idToBytes(requestId))
        .execute();
      await transaction
        .updateTable("request_drafts")
        .set({
          target_url: normalizedUrl,
          draft_revision: expectedDraftRevision + 1,
          updated_by: idToBytes(userId),
          updated_at: Date.now(),
        })
        .where("request_id", "=", idToBytes(requestId))
        .execute();
      await this.#audit.record(transaction, {
        type: "request.draft_updated",
        actorUserId: userId,
        workspaceId,
        data: { requestId, draftRevision: expectedDraftRevision + 1 },
      });
      return {
        ...mapRequest(row),
        name: normalizeName(name),
        targetUrl: normalizedUrl,
        draftRevision: expectedDraftRevision + 1,
      };
    });
  }

  /** Creates an execution snapshot and reuses an identical latest revision. */
  async prepareExecution(
    userId: EntityId,
    requestId: EntityId,
  ): Promise<PreparedExecution> {
    return this.#database.transaction().execute(async (transaction) => {
      const row = await this.#requestRow(transaction, requestId);
      const request = mapRequest(row);
      await this.#workspaces.requireCanEdit(
        transaction,
        userId,
        request.workspaceId,
      );
      const content = JSON.stringify({
        method: request.method,
        targetMode: request.targetMode,
        targetUrl: request.targetUrl,
        queryMode: request.queryMode,
      });
      const fingerprint = createHash("sha256").update(content).digest("hex");
      const latest = await transaction
        .selectFrom("request_revisions")
        .select(["id", "content_fingerprint"])
        .where("request_id", "=", idToBytes(requestId))
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .executeTakeFirst();
      // Reuse an identical latest snapshot so repeated executions do not create
      // empty history entries. A changed draft gets a new immutable revision.
      const revisionId =
        latest?.content_fingerprint === fingerprint
          ? bytesToId(latest.id)
          : await this.#createRevision(
              transaction,
              requestId,
              userId,
              content,
              fingerprint,
              latest === undefined ? null : bytesToId(latest.id),
            );
      const executionId = createEntityId();
      const createdAt = Date.now();
      await transaction
        .insertInto("executions")
        .values({
          id: idToBytes(executionId),
          request_id: idToBytes(requestId),
          request_revision_id: idToBytes(revisionId),
          created_by: idToBytes(userId),
          state: "created",
          snapshot_json: content,
          response_status: null,
          response_headers_json: null,
          response_blob_id: null,
          body_complete: 0,
          body_bytes: null,
          body_sha256: null,
          error_json: null,
          created_at: createdAt,
          completed_at: null,
        })
        .execute();
      await this.#audit.record(transaction, {
        type: "execution.created",
        actorUserId: userId,
        workspaceId: request.workspaceId,
        data: { executionId, requestId, revisionId },
      });
      return { executionId, revisionId, request, createdAt };
    });
  }

  /** Persists one immutable execution-triggered request revision. */
  async #createRevision(
    transaction: Transaction<DatabaseSchema>,
    requestId: EntityId,
    userId: EntityId,
    content: string,
    fingerprint: string,
    parentRevisionId: EntityId | null,
  ): Promise<EntityId> {
    const revisionId = createEntityId();
    await transaction
      .insertInto("request_revisions")
      .values({
        id: idToBytes(revisionId),
        request_id: idToBytes(requestId),
        parent_revision_id:
          parentRevisionId === null ? null : idToBytes(parentRevisionId),
        creation_reason: "execution",
        created_by: idToBytes(userId),
        created_at: Date.now(),
        content_json: content,
        content_fingerprint: fingerprint,
      })
      .execute();
    return revisionId;
  }

  /** Loads request draft and tree metadata or raises resource-not-found. */
  async #requestRow(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    requestId: EntityId,
  ) {
    const row = await database
      .selectFrom("request_drafts as draft")
      .innerJoin("workspace_tree_nodes as node", "node.id", "draft.request_id")
      .select([
        "draft.request_id",
        "draft.draft_revision",
        "draft.method",
        "draft.target_mode",
        "draft.target_url",
        "draft.query_mode",
        "node.workspace_id",
        "node.name",
      ])
      .where("draft.request_id", "=", idToBytes(requestId))
      .executeTakeFirst();
    if (row === undefined) {
      throw new ResourceNotFoundError("Request not found");
    }
    return row;
  }

  /** Requires a parent to be a collection in the same workspace. */
  async #validateParent(
    transaction: Transaction<DatabaseSchema>,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
  ): Promise<void> {
    if (parentCollectionId === null) {
      return;
    }
    const parent = await transaction
      .selectFrom("workspace_tree_nodes")
      .select(["workspace_id", "kind"])
      .where("id", "=", idToBytes(parentCollectionId))
      .executeTakeFirst();
    if (
      parent === undefined ||
      bytesToId(parent.workspace_id) !== workspaceId ||
      parent.kind !== "collection"
    ) {
      throw new ResourceNotFoundError("Parent collection not found");
    }
  }

  /** Returns the append position for one ordered collection child list. */
  async #nextPosition(
    transaction: Transaction<DatabaseSchema>,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
  ): Promise<number> {
    let query = transaction
      .selectFrom("workspace_tree_nodes")
      .select(({ fn }) => fn.max<number>("position").as("position"))
      .where("workspace_id", "=", idToBytes(workspaceId));
    query =
      parentCollectionId === null
        ? query.where("parent_collection_id", "is", null)
        : query.where(
            "parent_collection_id",
            "=",
            idToBytes(parentCollectionId),
          );
    const row = await query.executeTakeFirstOrThrow();
    return row.position === null ? 0 : Number(row.position) + 1;
  }
}

/** Normalizes an absolute HTTP target URL without query or fragment data. */
function validateTargetUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "Target URL must be an absolute HTTP URL without user information, query, or fragment",
    );
  }
  return url.toString();
}

/** Maps persistence naming and binary identifiers to the request view contract. */
function mapRequest(row: {
  readonly request_id: Uint8Array;
  readonly workspace_id: Uint8Array;
  readonly name: string;
  readonly method: "GET";
  readonly target_mode: "absolute";
  readonly target_url: string;
  readonly query_mode: "structured";
  readonly draft_revision: number;
}): RequestView {
  return {
    requestId: bytesToId(row.request_id),
    workspaceId: bytesToId(row.workspace_id),
    name: row.name,
    method: row.method,
    targetMode: row.target_mode,
    targetUrl: row.target_url,
    queryMode: row.query_mode,
    draftRevision: row.draft_revision,
  };
}
