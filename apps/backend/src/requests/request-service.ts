import { createHash } from "node:crypto";

import { sql, type Kysely, type Transaction } from "kysely";

import type { AuditService } from "../audit/audit-service.js";
import {
  VariableResolver,
  type SecretReference,
} from "../environments/variable-resolver.js";
import {
  bytesToId,
  createEntityId,
  idToBytes,
  type EntityId,
} from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";
import type { ScriptRequest } from "../scripting/script-types.js";
import type { VariableService } from "../variables/variable-service.js";
import type {
  VariablePreviewSource,
  VariableProfileEvidence,
} from "../variables/variable-service.js";
import type { ResolvedVariable } from "../variables/variable-profile-store.js";
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
  readonly orderRevision: number;
  readonly method?: HttpMethod;
}

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export type TreeMovePlacement = "before" | "inside" | "after";

export interface RequestField {
  readonly name: string;
  readonly value: string;
  readonly enabled: boolean;
}

export interface CollectionView {
  readonly collectionId: EntityId;
  readonly workspaceId: EntityId;
  readonly parentCollectionId: EntityId | null;
  readonly name: string;
  readonly headers: readonly RequestField[];
  /** Contains the enabled root-to-current header overlay for presentation. */
  readonly effectiveHeaders: readonly RequestField[];
  readonly revision: number;
}

export interface RequestView {
  readonly requestId: EntityId;
  readonly workspaceId: EntityId;
  readonly parentCollectionId: EntityId | null;
  readonly name: string;
  readonly method: HttpMethod;
  readonly targetMode: "absolute";
  readonly targetUrl: string;
  readonly queryMode: "structured";
  readonly query: readonly RequestField[];
  readonly headers: readonly RequestField[];
  /** Contains effective collection headers before request-local overrides. */
  readonly inheritedHeaders: readonly RequestField[];
  readonly body: string;
  readonly preRequestScript: string;
  readonly postResponseScript: string;
  readonly draftRevision: number;
}

export interface RequestExecutionInput {
  readonly method: HttpMethod;
  readonly targetUrl: string;
  readonly query: readonly RequestField[];
  readonly headers: readonly RequestField[];
  readonly body: string;
  readonly preRequestScript?: string;
  readonly postResponseScript?: string;
}

export interface ExecutionRequestSnapshot extends RequestExecutionInput {
  readonly workspaceId: EntityId;
  readonly requestId?: EntityId;
  readonly bodyBytes?: Uint8Array;
  readonly preRequestScript: string;
  readonly postResponseScript: string;
}

export interface PreparedExecution {
  readonly executionId: EntityId;
  readonly revisionId?: EntityId;
  readonly request: ExecutionRequestSnapshot;
  readonly variables: readonly ResolvedVariable[];
  readonly variableSources: ReadonlyMap<string, VariablePreviewSource>;
  readonly variableEvidence: readonly VariableProfileEvidence[];
  readonly postScriptRequest?: ScriptRequest;
  readonly materialized: boolean;
  readonly createdAt: number;
}

/** Represents the persistence projection required to build a request view. */
interface RequestRow {
  readonly request_id: Uint8Array;
  readonly workspace_id: Uint8Array;
  readonly parent_collection_id: Uint8Array | null;
  readonly name: string;
  readonly method: HttpMethod;
  readonly target_mode: "absolute";
  readonly target_url: string;
  readonly query_mode: "structured";
  readonly query_json: string;
  readonly headers_json: string;
  readonly body_text: string;
  readonly pre_request_script: string;
  readonly post_response_script: string;
  readonly draft_revision: number;
}

/** Represents the persistence projection required to build a collection view. */
interface CollectionRow {
  readonly id: Uint8Array;
  readonly workspace_id: Uint8Array;
  readonly parent_collection_id: Uint8Array | null;
  readonly name: string;
  readonly profile_revision: number | null;
  readonly headers_json: string | null;
}

/** Raised when an update targets a stale persisted draft revision. */
export class DraftConflictError extends Error {}

/** Raised when a collection profile update targets a stale revision. */
export class CollectionProfileConflictError extends Error {}

/** Raised when a sibling reorder targets a stale tree order. */
export class TreeOrderConflictError extends Error {}

/** Raised when a tree move would create an invalid collection hierarchy. */
export class TreeMoveInvalidError extends Error {}

/**
 * Owns the ordered collection/request tree and mutable request drafts.
 *
 * Draft edits use optimistic revision checks. Executions reference immutable
 * request revisions, creating one only when current draft content has changed.
 */
export class RequestService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #workspaces: WorkspaceService;
  readonly #variables: VariableService;
  readonly #audit: AuditService;

  constructor(
    database: Kysely<DatabaseSchema>,
    workspaces: WorkspaceService,
    variables: VariableService,
    audit: AuditService,
  ) {
    this.#database = database;
    this.#workspaces = workspaces;
    this.#variables = variables;
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
      .leftJoin("request_drafts", "request_drafts.request_id", "id")
      .select([
        "id",
        "kind",
        "name",
        "position",
        "order_revision",
        "request_drafts.method",
      ])
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
      orderRevision: row.order_revision,
      ...(row.method === null ? {} : { method: row.method }),
    }));
  }

  /** Reorders one complete authorized sibling list without changing parents. */
  async reorderChildren(
    userId: EntityId,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
    expectedOrderRevision: number,
    orderedNodeIds: readonly EntityId[],
  ): Promise<{ readonly orderRevision: number }> {
    return this.#database.transaction().execute(async (transaction) => {
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      await this.#validateParent(transaction, workspaceId, parentCollectionId);
      let query = transaction
        .selectFrom("workspace_tree_nodes")
        .select(["id", "position", "order_revision"])
        .where("workspace_id", "=", idToBytes(workspaceId));
      query =
        parentCollectionId === null
          ? query.where("parent_collection_id", "is", null)
          : query.where(
              "parent_collection_id",
              "=",
              idToBytes(parentCollectionId),
            );
      const rows = await query.orderBy("position").execute();
      const currentOrderRevision = rows.reduce(
        (revision, row) => Math.max(revision, row.order_revision),
        0,
      );
      const currentNodeIds = rows.map((row) => bytesToId(row.id));
      const requestedNodeIds = new Set(orderedNodeIds);
      if (
        currentOrderRevision !== expectedOrderRevision ||
        requestedNodeIds.size !== orderedNodeIds.length ||
        orderedNodeIds.length !== currentNodeIds.length ||
        orderedNodeIds.some((nodeId) => !currentNodeIds.includes(nodeId))
      ) {
        throw new TreeOrderConflictError("The tree order changed");
      }
      if (
        orderedNodeIds.every(
          (nodeId, position) => nodeId === currentNodeIds[position],
        )
      ) {
        return { orderRevision: currentOrderRevision };
      }

      const temporaryOffset =
        rows.reduce((highest, row) => Math.max(highest, row.position), -1) + 1;
      let offsetQuery = transaction
        .updateTable("workspace_tree_nodes")
        .set({ position: sql<number>`position + ${temporaryOffset}` })
        .where("workspace_id", "=", idToBytes(workspaceId));
      offsetQuery =
        parentCollectionId === null
          ? offsetQuery.where("parent_collection_id", "is", null)
          : offsetQuery.where(
              "parent_collection_id",
              "=",
              idToBytes(parentCollectionId),
            );
      await offsetQuery.execute();

      const orderRevision = currentOrderRevision + 1;
      for (const [position, nodeId] of orderedNodeIds.entries()) {
        await transaction
          .updateTable("workspace_tree_nodes")
          .set({ position, order_revision: orderRevision })
          .where("id", "=", idToBytes(nodeId))
          .executeTakeFirstOrThrow();
      }
      await this.#audit.record(transaction, {
        type: "tree.reordered",
        actorUserId: userId,
        workspaceId,
        data: {
          parentCollectionId,
          orderedNodeIds,
          orderRevision,
        },
      });
      return { orderRevision };
    });
  }

  /** Moves one node relative to another node, including between tree levels. */
  async moveNode(
    userId: EntityId,
    workspaceId: EntityId,
    nodeId: EntityId,
    targetNodeId: EntityId,
    placement: TreeMovePlacement,
    expectedSourceOrderRevision: number,
  ): Promise<{
    readonly sourceParentCollectionId: EntityId | null;
    readonly targetParentCollectionId: EntityId | null;
  }> {
    return this.#database.transaction().execute(async (transaction) => {
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      const [movingNode, targetNode] = await Promise.all([
        transaction
          .selectFrom("workspace_tree_nodes")
          .select(["workspace_id", "parent_collection_id", "kind"])
          .where("id", "=", idToBytes(nodeId))
          .executeTakeFirst(),
        transaction
          .selectFrom("workspace_tree_nodes")
          .select(["workspace_id", "parent_collection_id", "kind", "position"])
          .where("id", "=", idToBytes(targetNodeId))
          .executeTakeFirst(),
      ]);
      if (
        movingNode === undefined ||
        targetNode === undefined ||
        bytesToId(movingNode.workspace_id) !== workspaceId ||
        bytesToId(targetNode.workspace_id) !== workspaceId
      ) {
        throw new ResourceNotFoundError("Tree node not found");
      }
      if (nodeId === targetNodeId) {
        throw new TreeMoveInvalidError("A node cannot be moved onto itself");
      }
      if (placement === "inside" && targetNode.kind !== "collection") {
        throw new TreeMoveInvalidError(
          "Only collections can contain tree nodes",
        );
      }

      const sourceParentCollectionId =
        movingNode.parent_collection_id === null
          ? null
          : bytesToId(movingNode.parent_collection_id);
      const targetParentCollectionId =
        placement === "inside"
          ? targetNodeId
          : targetNode.parent_collection_id === null
            ? null
            : bytesToId(targetNode.parent_collection_id);
      if (sourceParentCollectionId === targetParentCollectionId) {
        throw new TreeMoveInvalidError(
          "Use sibling reordering when the parent does not change",
        );
      }
      await this.#validateMoveHierarchy(
        transaction,
        workspaceId,
        nodeId,
        movingNode.kind,
        targetParentCollectionId,
      );

      const sourceRows = await this.#listSiblingOrder(
        transaction,
        workspaceId,
        sourceParentCollectionId,
      );
      const sourceOrderRevision = sourceRows.reduce(
        (revision, row) => Math.max(revision, row.orderRevision),
        0,
      );
      if (
        sourceOrderRevision !== expectedSourceOrderRevision ||
        !sourceRows.some((row) => row.nodeId === nodeId)
      ) {
        throw new TreeOrderConflictError("The tree order changed");
      }
      const targetRows = await this.#listSiblingOrder(
        transaction,
        workspaceId,
        targetParentCollectionId,
      );
      const targetOrderRevision = targetRows.reduce(
        (revision, row) => Math.max(revision, row.orderRevision),
        0,
      );
      const targetSiblingIndex = targetRows.findIndex(
        (row) => row.nodeId === targetNodeId,
      );
      if (placement !== "inside" && targetSiblingIndex < 0) {
        throw new TreeOrderConflictError("The tree order changed");
      }
      const targetIndex =
        placement === "inside"
          ? targetRows.length
          : targetSiblingIndex + (placement === "after" ? 1 : 0);

      await this.#offsetSiblingPositions(
        transaction,
        workspaceId,
        sourceParentCollectionId,
      );
      await this.#offsetSiblingPositions(
        transaction,
        workspaceId,
        targetParentCollectionId,
      );
      const sourceNodeIds = sourceRows
        .map((row) => row.nodeId)
        .filter((candidate) => candidate !== nodeId);
      const nextSourceOrderRevision = sourceOrderRevision + 1;
      for (const [position, sourceNodeId] of sourceNodeIds.entries()) {
        await transaction
          .updateTable("workspace_tree_nodes")
          .set({ position, order_revision: nextSourceOrderRevision })
          .where("id", "=", idToBytes(sourceNodeId))
          .executeTakeFirstOrThrow();
      }

      const targetNodeIds = targetRows.map((row) => row.nodeId);
      targetNodeIds.splice(targetIndex, 0, nodeId);
      const nextTargetOrderRevision = targetOrderRevision + 1;
      for (const [position, destinationNodeId] of targetNodeIds.entries()) {
        await transaction
          .updateTable("workspace_tree_nodes")
          .set({
            position,
            order_revision: nextTargetOrderRevision,
            ...(destinationNodeId === nodeId
              ? {
                  parent_collection_id:
                    targetParentCollectionId === null
                      ? null
                      : idToBytes(targetParentCollectionId),
                }
              : {}),
          })
          .where("id", "=", idToBytes(destinationNodeId))
          .executeTakeFirstOrThrow();
      }
      await this.#audit.record(transaction, {
        type: "tree.moved",
        actorUserId: userId,
        workspaceId,
        data: {
          nodeId,
          targetNodeId,
          placement,
          sourceParentCollectionId,
          targetParentCollectionId,
          sourceOrderRevision: nextSourceOrderRevision,
          targetOrderRevision: nextTargetOrderRevision,
        },
      });
      return { sourceParentCollectionId, targetParentCollectionId };
    });
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
      const orderRevision = await this.#currentOrderRevision(
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
          order_revision: orderRevision,
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
        orderRevision,
      };
    });
  }

  /** Loads one authorized collection and its common-header profile. */
  async getCollection(
    userId: EntityId,
    collectionId: EntityId,
  ): Promise<CollectionView> {
    const row = await this.#collectionRow(this.#database, collectionId);
    await this.#workspaces.requireCanRead(
      this.#database,
      userId,
      bytesToId(row.workspace_id),
    );
    return this.#collectionView(this.#database, row);
  }

  /** Replaces a collection's name and common headers using one revision. */
  async updateCollection(
    userId: EntityId,
    collectionId: EntityId,
    expectedRevision: number,
    name: string,
    headers: readonly RequestField[],
  ): Promise<CollectionView> {
    const normalizedName = normalizeName(name);
    const normalizedHeaders = validateHeaders(headers);
    const headersJson = JSON.stringify(normalizedHeaders);
    return this.#database.transaction().execute(async (transaction) => {
      const row = await this.#collectionRow(transaction, collectionId);
      const workspaceId = bytesToId(row.workspace_id);
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      const currentRevision = row.profile_revision ?? 0;
      if (currentRevision !== expectedRevision) {
        throw new CollectionProfileConflictError(
          "The collection properties changed",
        );
      }
      const nameChanged = row.name !== normalizedName;
      const headersChanged = (row.headers_json ?? "[]") !== headersJson;
      if (!nameChanged && !headersChanged) {
        return this.#collectionView(transaction, row);
      }
      const revision = currentRevision + 1;
      const now = Date.now();
      if (row.profile_revision === null) {
        const result = await transaction
          .insertInto("collection_profiles")
          .values({
            collection_id: idToBytes(collectionId),
            revision,
            headers_json: headersJson,
            updated_by: idToBytes(userId),
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.column("collection_id").doNothing(),
          )
          .executeTakeFirst();
        if (result.numInsertedOrUpdatedRows !== 1n) {
          throw new CollectionProfileConflictError(
            "The collection properties changed",
          );
        }
      } else {
        const result = await transaction
          .updateTable("collection_profiles")
          .set({
            revision,
            headers_json: headersJson,
            updated_by: idToBytes(userId),
            updated_at: now,
          })
          .where("collection_id", "=", idToBytes(collectionId))
          .where("revision", "=", expectedRevision)
          .executeTakeFirst();
        if (result.numUpdatedRows !== 1n) {
          throw new CollectionProfileConflictError(
            "The collection properties changed",
          );
        }
      }
      if (nameChanged) {
        await transaction
          .updateTable("workspace_tree_nodes")
          .set({ name: normalizedName })
          .where("id", "=", idToBytes(collectionId))
          .where("kind", "=", "collection")
          .execute();
      }
      await this.#audit.record(transaction, {
        type: "collection.updated",
        actorUserId: userId,
        workspaceId,
        data: { collectionId, revision, nameChanged, headersChanged },
      });
      return {
        ...mapCollection(row),
        name: normalizedName,
        headers: normalizedHeaders,
        effectiveHeaders: await this.#resolveHeaders(
          transaction,
          row.workspace_id,
          row.parent_collection_id,
          normalizedHeaders,
        ),
        revision,
      };
    });
  }

  /** Preserves the focused common-header update boundary for existing callers. */
  async updateCollectionHeaders(
    userId: EntityId,
    collectionId: EntityId,
    expectedRevision: number,
    headers: readonly RequestField[],
  ): Promise<CollectionView> {
    const row = await this.#collectionRow(this.#database, collectionId);
    return this.updateCollection(
      userId,
      collectionId,
      expectedRevision,
      row.name,
      headers,
    );
  }

  /** Appends a request draft to an authorized workspace parent. */
  async createRequest(
    userId: EntityId,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
    name: string,
    method: HttpMethod,
    targetUrl: string,
    query: readonly RequestField[],
    headers: readonly RequestField[],
    body: string,
    preRequestScript = "",
    postResponseScript = "",
  ): Promise<RequestView> {
    const content = normalizeExecutionInput({
      method,
      targetUrl,
      query,
      headers,
      body,
      preRequestScript,
      postResponseScript,
    });
    const normalizedName = normalizeName(name);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      await this.#validateParent(transaction, workspaceId, parentCollectionId);
      const position = await this.#nextPosition(
        transaction,
        workspaceId,
        parentCollectionId,
      );
      const orderRevision = await this.#currentOrderRevision(
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
          name: normalizedName,
          order_revision: orderRevision,
          created_at: now,
        })
        .execute();
      await transaction
        .insertInto("request_drafts")
        .values({
          request_id: idToBytes(requestId),
          draft_revision: 0,
          method: content.method,
          target_mode: "absolute",
          target_url: content.targetUrl,
          query_mode: "structured",
          query_json: JSON.stringify(content.query),
          headers_json: JSON.stringify(content.headers),
          body_text: content.body,
          pre_request_script: content.preRequestScript,
          post_response_script: content.postResponseScript,
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
      const inheritedHeaders = await this.#resolveHeaders(
        transaction,
        idToBytes(workspaceId),
        parentCollectionId === null ? null : idToBytes(parentCollectionId),
        [],
      );
      return {
        requestId,
        workspaceId,
        parentCollectionId,
        name: normalizedName,
        method: content.method,
        targetMode: "absolute",
        targetUrl: content.targetUrl,
        queryMode: "structured",
        query: content.query,
        headers: content.headers,
        inheritedHeaders,
        body: content.body,
        preRequestScript: content.preRequestScript,
        postResponseScript: content.postResponseScript,
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
    return this.#requestView(this.#database, row);
  }

  /** Updates a request draft only when its expected revision is current. */
  async update(
    userId: EntityId,
    requestId: EntityId,
    expectedDraftRevision: number,
    name: string,
    method: HttpMethod,
    targetUrl: string,
    query: readonly RequestField[],
    headers: readonly RequestField[],
    body: string,
    preRequestScript = "",
    postResponseScript = "",
  ): Promise<RequestView> {
    const normalizedName = normalizeName(name);
    const content = normalizeExecutionInput({
      method,
      targetUrl,
      query,
      headers,
      body,
      preRequestScript,
      postResponseScript,
    });
    const queryJson = JSON.stringify(content.query);
    const headersJson = JSON.stringify(content.headers);
    return this.#database.transaction().execute(async (transaction) => {
      const row = await this.#requestRow(transaction, requestId);
      const workspaceId = bytesToId(row.workspace_id);
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      if (row.draft_revision !== expectedDraftRevision) {
        throw new DraftConflictError("The request draft changed");
      }
      if (
        row.name === normalizedName &&
        row.method === content.method &&
        row.target_url === content.targetUrl &&
        row.query_json === queryJson &&
        row.headers_json === headersJson &&
        row.body_text === content.body &&
        row.pre_request_script === content.preRequestScript &&
        row.post_response_script === content.postResponseScript
      ) {
        return this.#requestView(transaction, row);
      }
      await transaction
        .updateTable("workspace_tree_nodes")
        .set({ name: normalizedName })
        .where("id", "=", idToBytes(requestId))
        .execute();
      await transaction
        .updateTable("request_drafts")
        .set({
          method: content.method,
          target_url: content.targetUrl,
          query_json: queryJson,
          headers_json: headersJson,
          body_text: content.body,
          pre_request_script: content.preRequestScript,
          post_response_script: content.postResponseScript,
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
        ...(await this.#requestView(transaction, row)),
        name: normalizedName,
        method: content.method,
        targetUrl: content.targetUrl,
        query: content.query,
        headers: content.headers,
        body: content.body,
        preRequestScript: content.preRequestScript,
        postResponseScript: content.postResponseScript,
        draftRevision: expectedDraftRevision + 1,
      };
    });
  }

  /** Creates an execution snapshot and reuses an identical latest revision. */
  async prepareExecution(
    userId: EntityId,
    sessionId: EntityId,
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
      const resolvedHeaders = await this.#resolveHeaders(
        transaction,
        row.workspace_id,
        row.parent_collection_id,
        request.headers,
      );
      const variableProfile = await this.#variables.effectiveProfile(
        transaction,
        sessionId,
        request.workspaceId,
        request.parentCollectionId,
        requestId,
      );
      const executionRequest = { ...request, headers: resolvedHeaders };
      const eagerlyComposed =
        request.preRequestScript === "" && request.postResponseScript === ""
          ? composeWithVariables(
              executionRequest,
              new VariableResolver(variableProfile.variables),
            )
          : undefined;
      const content = JSON.stringify({
        method: request.method,
        targetMode: request.targetMode,
        targetUrl: request.targetUrl,
        queryMode: request.queryMode,
        query: request.query,
        headers: resolvedHeaders,
        body: request.body,
        preRequestScript: request.preRequestScript,
        postResponseScript: request.postResponseScript,
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
          workspace_id: idToBytes(request.workspaceId),
          request_id: idToBytes(requestId),
          request_revision_id: idToBytes(revisionId),
          created_by: idToBytes(userId),
          state: "created",
          snapshot_json: JSON.stringify({
            ...(eagerlyComposed?.persisted ?? executionRequest),
            targetMode: "absolute",
            queryMode: "structured",
            variableProfiles: variableProfile.evidence,
            secretReferences: eagerlyComposed?.secretReferences ?? [],
          }),
          response_status: null,
          response_headers_json: null,
          response_blob_id: null,
          body_complete: 0,
          body_bytes: null,
          body_sha256: null,
          error_json: null,
          script_result_json: null,
          created_at: createdAt,
          completed_at: null,
        })
        .execute();
      await this.#audit.record(transaction, {
        type: "execution.created",
        actorUserId: userId,
        workspaceId: request.workspaceId,
        data: {
          executionId,
          requestId,
          revisionId,
          secretBearing: variableProfile.variables.some(
            (variable) => variable.kind === "secret",
          ),
        },
      });
      return {
        executionId,
        revisionId,
        request: eagerlyComposed?.request ?? executionRequest,
        variables: variableProfile.variables,
        variableSources: variableProfile.sources,
        variableEvidence: variableProfile.evidence,
        materialized: eagerlyComposed !== undefined,
        createdAt,
      };
    });
  }

  /** Creates a durable workspace-owned execution without saving a request. */
  async prepareTemporaryExecution(
    userId: EntityId,
    sessionId: EntityId,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
    input: RequestExecutionInput,
  ): Promise<PreparedExecution> {
    const localRequest = {
      workspaceId,
      ...normalizeExecutionInput(input),
    };
    return this.#database.transaction().execute(async (transaction) => {
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      await this.#validateParent(transaction, workspaceId, parentCollectionId);
      const resolvedHeaders = await this.#resolveHeaders(
        transaction,
        idToBytes(workspaceId),
        parentCollectionId === null ? null : idToBytes(parentCollectionId),
        localRequest.headers,
      );
      const variableProfile = await this.#variables.effectiveProfile(
        transaction,
        sessionId,
        workspaceId,
        parentCollectionId,
        null,
      );
      const executionRequest = { ...localRequest, headers: resolvedHeaders };
      const eagerlyComposed =
        localRequest.preRequestScript === "" &&
        localRequest.postResponseScript === ""
          ? composeWithVariables(
              executionRequest,
              new VariableResolver(variableProfile.variables),
            )
          : undefined;
      const executionId = createEntityId();
      const createdAt = Date.now();
      const snapshot = JSON.stringify({
        ...(eagerlyComposed?.persisted ?? executionRequest),
        targetMode: "absolute",
        queryMode: "structured",
        variableProfiles: variableProfile.evidence,
        secretReferences: eagerlyComposed?.secretReferences ?? [],
      });
      await transaction
        .insertInto("executions")
        .values({
          id: idToBytes(executionId),
          workspace_id: idToBytes(workspaceId),
          request_id: null,
          request_revision_id: null,
          created_by: idToBytes(userId),
          state: "created",
          snapshot_json: snapshot,
          response_status: null,
          response_headers_json: null,
          response_blob_id: null,
          body_complete: 0,
          body_bytes: null,
          body_sha256: null,
          error_json: null,
          script_result_json: null,
          created_at: createdAt,
          completed_at: null,
        })
        .execute();
      await this.#audit.record(transaction, {
        type: "execution.created",
        actorUserId: userId,
        workspaceId,
        data: {
          executionId,
          requestId: null,
          revisionId: null,
          secretBearing: variableProfile.variables.some(
            (variable) => variable.kind === "secret",
          ),
        },
      });
      return {
        executionId,
        request: eagerlyComposed?.request ?? executionRequest,
        variables: variableProfile.variables,
        variableSources: variableProfile.sources,
        variableEvidence: variableProfile.evidence,
        materialized: eagerlyComposed !== undefined,
        createdAt,
      };
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
        "draft.query_json",
        "draft.headers_json",
        "draft.body_text",
        "draft.pre_request_script",
        "draft.post_response_script",
        "node.workspace_id",
        "node.parent_collection_id",
        "node.name",
      ])
      .where("draft.request_id", "=", idToBytes(requestId))
      .executeTakeFirst();
    if (row === undefined) {
      throw new ResourceNotFoundError("Request not found");
    }
    return row;
  }

  /** Loads collection metadata and an optional header profile. */
  async #collectionRow(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    collectionId: EntityId,
  ) {
    const row = await database
      .selectFrom("workspace_tree_nodes as node")
      .leftJoin(
        "collection_profiles as profile",
        "profile.collection_id",
        "node.id",
      )
      .select([
        "node.id",
        "node.workspace_id",
        "node.parent_collection_id",
        "node.name",
        "profile.revision as profile_revision",
        "profile.headers_json",
      ])
      .where("node.id", "=", idToBytes(collectionId))
      .where("node.kind", "=", "collection")
      .executeTakeFirst();
    if (row === undefined) {
      throw new ResourceNotFoundError("Collection not found");
    }
    return row;
  }

  /** Builds a collection view with its current effective ancestor overlay. */
  async #collectionView(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    row: CollectionRow,
  ): Promise<CollectionView> {
    const collection = mapCollection(row);
    return {
      ...collection,
      effectiveHeaders: await this.#resolveHeaders(
        database,
        row.workspace_id,
        row.parent_collection_id,
        collection.headers,
      ),
    };
  }

  /** Builds a request view with effective collection headers kept read-only. */
  async #requestView(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    row: RequestRow,
  ): Promise<RequestView> {
    return {
      ...mapRequest(row),
      inheritedHeaders: await this.#resolveHeaders(
        database,
        row.workspace_id,
        row.parent_collection_id,
        [],
      ),
    };
  }

  /** Resolves workspace and collection header layers before local overrides. */
  async #resolveHeaders(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    workspaceId: Uint8Array,
    parentCollectionId: Uint8Array | null,
    requestHeaders: readonly RequestField[],
  ): Promise<RequestField[]> {
    const workspace = await database
      .selectFrom("workspaces")
      .select("headers_json")
      .where("id", "=", workspaceId)
      .executeTakeFirst();
    if (workspace === undefined) {
      throw new ResourceNotFoundError("Workspace not found");
    }
    const workspaceHeaders = validateHeaders(
      JSON.parse(workspace.headers_json) as readonly RequestField[],
    );
    const collectionLayers: RequestField[][] = [];
    const visited = new Set<string>();
    let currentId = parentCollectionId;
    while (currentId !== null) {
      const key = Buffer.from(currentId).toString("hex");
      if (visited.has(key) || visited.size >= 64) {
        throw new Error("Collection hierarchy is cyclic or too deep");
      }
      visited.add(key);
      const row = await database
        .selectFrom("workspace_tree_nodes as node")
        .leftJoin(
          "collection_profiles as profile",
          "profile.collection_id",
          "node.id",
        )
        .select(["node.parent_collection_id", "profile.headers_json"])
        .where("node.id", "=", currentId)
        .where("node.kind", "=", "collection")
        .executeTakeFirst();
      if (row === undefined) {
        throw new ResourceNotFoundError("Parent collection not found");
      }
      collectionLayers.unshift(
        validateHeaders(
          JSON.parse(row.headers_json ?? "[]") as readonly RequestField[],
        ),
      );
      currentId = row.parent_collection_id;
    }
    return resolveHeaderLayers([
      workspaceHeaders,
      ...collectionLayers,
      validateHeaders(requestHeaders),
    ]);
  }

  /** Lists the stable identifiers and revisions for one sibling boundary. */
  async #listSiblingOrder(
    transaction: Transaction<DatabaseSchema>,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
  ): Promise<
    readonly {
      readonly nodeId: EntityId;
      readonly position: number;
      readonly orderRevision: number;
    }[]
  > {
    let query = transaction
      .selectFrom("workspace_tree_nodes")
      .select(["id", "position", "order_revision"])
      .where("workspace_id", "=", idToBytes(workspaceId));
    query =
      parentCollectionId === null
        ? query.where("parent_collection_id", "is", null)
        : query.where(
            "parent_collection_id",
            "=",
            idToBytes(parentCollectionId),
          );
    const rows = await query.orderBy("position").execute();
    return rows.map((row) => ({
      nodeId: bytesToId(row.id),
      position: row.position,
      orderRevision: row.order_revision,
    }));
  }

  /** Frees the final position range before rewriting one sibling order. */
  async #offsetSiblingPositions(
    transaction: Transaction<DatabaseSchema>,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
  ): Promise<void> {
    const offset = await this.#nextPosition(
      transaction,
      workspaceId,
      parentCollectionId,
    );
    if (offset === 0) return;
    let query = transaction
      .updateTable("workspace_tree_nodes")
      .set({ position: sql<number>`position + ${offset}` })
      .where("workspace_id", "=", idToBytes(workspaceId));
    query =
      parentCollectionId === null
        ? query.where("parent_collection_id", "is", null)
        : query.where(
            "parent_collection_id",
            "=",
            idToBytes(parentCollectionId),
          );
    await query.execute();
  }

  /** Rejects collection moves into themselves, descendants, or corrupt trees. */
  async #validateMoveHierarchy(
    transaction: Transaction<DatabaseSchema>,
    workspaceId: EntityId,
    nodeId: EntityId,
    nodeKind: "collection" | "request",
    targetParentCollectionId: EntityId | null,
  ): Promise<void> {
    await this.#validateParent(
      transaction,
      workspaceId,
      targetParentCollectionId,
    );
    if (nodeKind !== "collection") return;
    let ancestorId = targetParentCollectionId;
    const visited = new Set<EntityId>();
    while (ancestorId !== null) {
      if (ancestorId === nodeId) {
        throw new TreeMoveInvalidError(
          "A collection cannot be moved into its own descendants",
        );
      }
      if (visited.has(ancestorId) || visited.size >= 64) {
        throw new TreeMoveInvalidError(
          "The collection hierarchy is cyclic or too deep",
        );
      }
      visited.add(ancestorId);
      const ancestor = await transaction
        .selectFrom("workspace_tree_nodes")
        .select("parent_collection_id")
        .where("id", "=", idToBytes(ancestorId))
        .where("workspace_id", "=", idToBytes(workspaceId))
        .where("kind", "=", "collection")
        .executeTakeFirst();
      if (ancestor === undefined) {
        throw new ResourceNotFoundError("Parent collection not found");
      }
      ancestorId =
        ancestor.parent_collection_id === null
          ? null
          : bytesToId(ancestor.parent_collection_id);
    }
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

  /** Returns the optimistic ordering revision shared by one sibling list. */
  async #currentOrderRevision(
    transaction: Transaction<DatabaseSchema>,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
  ): Promise<number> {
    let query = transaction
      .selectFrom("workspace_tree_nodes")
      .select(({ fn }) => fn.max<number>("order_revision").as("order_revision"))
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
    return row.order_revision === null ? 0 : Number(row.order_revision);
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

/** Accepts either a final URL or a bounded URL template for later composition. */
function validateTargetTemplate(value: string): string {
  if (value.includes("<<")) {
    if (
      value.length === 0 ||
      value.length > 8192 ||
      value.includes("?") ||
      value.includes("#")
    ) {
      throw new Error("Target URL template is invalid");
    }
    return value;
  }
  return validateTargetUrl(value);
}

/** Accepts one method from the request editor's supported HTTP method set. */
function validateMethod(value: string): HttpMethod {
  switch (value) {
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "HEAD":
    case "OPTIONS":
      return value;
    default:
      throw new Error("HTTP method is not supported");
  }
}

/** Validates structured query fields while preserving order and disabled rows. */
function validateQuery(fields: readonly RequestField[]): RequestField[] {
  return fields.map((field) => {
    if (
      typeof field.name !== "string" ||
      typeof field.value !== "string" ||
      typeof field.enabled !== "boolean"
    ) {
      throw new Error("Query fields are invalid");
    }
    return { name: field.name, value: field.value, enabled: field.enabled };
  });
}

/** Validates ordered request headers and rejects unsafe transport-owned names. */
function validateHeaders(fields: readonly RequestField[]): RequestField[] {
  const forbidden = new Set([
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "proxy-connection",
    "upgrade",
    "te",
    "trailer",
    "expect",
    "proxy-authorization",
  ]);
  return fields.map((field) => {
    if (
      typeof field.name !== "string" ||
      typeof field.value !== "string" ||
      typeof field.enabled !== "boolean"
    ) {
      throw new Error("Header fields are invalid");
    }
    if (
      field.enabled &&
      (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(field.name) ||
        hasInvalidHeaderValue(field.value) ||
        forbidden.has(field.name.toLowerCase()))
    ) {
      throw new Error(`Header ${field.name || "(empty)"} is not allowed`);
    }
    return { name: field.name, value: field.value, enabled: field.enabled };
  });
}

/** Detects HTTP header value control characters forbidden by the proxy API. */
function hasInvalidHeaderValue(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 8 || (code >= 10 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

/** Bounds the raw UTF-8 request body to the control-channel payload limit. */
function validateBody(value: string): string {
  if (Buffer.byteLength(value, "utf8") > 786_432) {
    throw new Error("Request body is too large");
  }
  return value;
}

/** Bounds one request script before it is persisted or sent to a worker. */
function validateScript(value: string): string {
  if (Buffer.byteLength(value, "utf8") > 65_536) {
    throw new Error("Request script is too large");
  }
  return value;
}

/** Normalizes and validates content shared by saved and temporary executions. */
function normalizeExecutionInput(
  input: RequestExecutionInput,
): RequestExecutionInput & {
  readonly preRequestScript: string;
  readonly postResponseScript: string;
} {
  return {
    method: validateMethod(input.method),
    targetUrl: validateTargetTemplate(input.targetUrl),
    query: validateQuery(input.query),
    headers: validateHeaders(input.headers),
    body: validateBody(input.body),
    preRequestScript: validateScript(input.preRequestScript ?? ""),
    postResponseScript: validateScript(input.postResponseScript ?? ""),
  };
}

/** Materializes variable-bearing request fields and builds a secret-safe view. */
export function composeWithVariables(
  request: ExecutionRequestSnapshot,
  resolver: VariableResolver,
): {
  readonly request: ExecutionRequestSnapshot;
  readonly persisted: RequestExecutionInput;
  readonly secretReferences: readonly SecretReference[];
} {
  const references = new Map<string, SecretReference>();
  /** Deduplicates secret references across every interpolated request field. */
  const retain = (items: readonly SecretReference[]): void => {
    for (const item of items) {
      references.set(item.variableId, item);
    }
  };
  const target = resolver.interpolate(request.targetUrl);
  retain(target.secretReferences);
  const query = request.query.map((field) => {
    if (!field.enabled) {
      return { materialized: field, persisted: field };
    }
    const value = resolver.interpolate(field.value);
    retain(value.secretReferences);
    return {
      materialized: { ...field, value: value.value },
      persisted: { ...field, value: value.secret ? "[secret]" : value.value },
    };
  });
  const headers = request.headers.map((field) => {
    if (!field.enabled) {
      return { materialized: field, persisted: field };
    }
    const value = resolver.interpolate(field.value);
    retain(value.secretReferences);
    return {
      materialized: { ...field, value: value.value },
      persisted: { ...field, value: value.secret ? "[secret]" : value.value },
    };
  });
  const body =
    request.bodyBytes === undefined ? resolver.interpolate(request.body) : null;
  if (body !== null) retain(body.secretReferences);
  const materialized: ExecutionRequestSnapshot = {
    ...request,
    targetUrl: validateTargetUrl(target.value),
    query: validateQuery(query.map((field) => field.materialized)),
    headers: validateHeaders(headers.map((field) => field.materialized)),
    body: body === null ? "" : validateBody(body.value),
  };
  return {
    request: materialized,
    persisted: {
      method: materialized.method,
      targetUrl: target.secret ? "[secret]" : materialized.targetUrl,
      query: query.map((field) => field.persisted),
      headers: headers.map((field) => field.persisted),
      body:
        request.bodyBytes === undefined
          ? body?.secret
            ? "[secret]"
            : (body?.value ?? "")
          : `[binary:${Buffer.from(request.bodyBytes).toString("base64")}]`,
      preRequestScript: materialized.preRequestScript,
      postResponseScript: materialized.postResponseScript,
    },
    secretReferences: [...references.values()],
  };
}

/** Maps persistence naming and binary identifiers to the request view contract. */
function mapRequest(row: {
  readonly request_id: Uint8Array;
  readonly workspace_id: Uint8Array;
  readonly parent_collection_id: Uint8Array | null;
  readonly name: string;
  readonly method: HttpMethod;
  readonly target_mode: "absolute";
  readonly target_url: string;
  readonly query_mode: "structured";
  readonly query_json: string;
  readonly headers_json: string;
  readonly body_text: string;
  readonly pre_request_script: string;
  readonly post_response_script: string;
  readonly draft_revision: number;
}): Omit<RequestView, "inheritedHeaders"> {
  return {
    requestId: bytesToId(row.request_id),
    workspaceId: bytesToId(row.workspace_id),
    parentCollectionId:
      row.parent_collection_id === null
        ? null
        : bytesToId(row.parent_collection_id),
    name: row.name,
    method: row.method,
    targetMode: row.target_mode,
    targetUrl: row.target_url,
    queryMode: row.query_mode,
    query: JSON.parse(row.query_json) as RequestField[],
    headers: JSON.parse(row.headers_json) as RequestField[],
    body: row.body_text,
    preRequestScript: row.pre_request_script,
    postResponseScript: row.post_response_script,
    draftRevision: row.draft_revision,
  };
}

/** Maps collection metadata and its optional profile to the public view. */
function mapCollection(row: {
  readonly id: Uint8Array;
  readonly workspace_id: Uint8Array;
  readonly parent_collection_id: Uint8Array | null;
  readonly name: string;
  readonly profile_revision: number | null;
  readonly headers_json: string | null;
}): Omit<CollectionView, "effectiveHeaders"> {
  return {
    collectionId: bytesToId(row.id),
    workspaceId: bytesToId(row.workspace_id),
    parentCollectionId:
      row.parent_collection_id === null
        ? null
        : bytesToId(row.parent_collection_id),
    name: row.name,
    headers: JSON.parse(row.headers_json ?? "[]") as RequestField[],
    revision: row.profile_revision ?? 0,
  };
}

/** Resolves enabled header groups with nearer layers replacing farther ones. */
export function resolveHeaderLayers(
  layers: readonly (readonly RequestField[])[],
): RequestField[] {
  let resolved: RequestField[] = [];
  for (const layer of layers) {
    const groups = new Map<string, RequestField[]>();
    for (const field of layer) {
      if (!field.enabled) {
        continue;
      }
      const key = field.name.toLowerCase();
      const group = groups.get(key) ?? [];
      group.push({ ...field });
      groups.set(key, group);
    }
    for (const [key, group] of groups) {
      resolved = resolved.filter((field) => field.name.toLowerCase() !== key);
      resolved.push(...group);
    }
  }
  return resolved;
}
