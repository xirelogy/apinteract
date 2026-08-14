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
  validateBaseUrlTemplate,
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
  /** Controls whether this header retains or replaces same-name ancestor values. */
  readonly mode?: "override" | "append";
}

export interface CollectionView {
  readonly collectionId: EntityId;
  readonly workspaceId: EntityId;
  readonly parentCollectionId: EntityId | null;
  readonly name: string;
  readonly pathPrefix: string;
  readonly inheritedTarget: string;
  readonly effectivePath: string;
  readonly headers: readonly RequestField[];
  /** Contains effective workspace and ancestor headers before local overrides. */
  readonly inheritedHeaders: readonly RequestField[];
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
  readonly targetMode: "absolute" | "composed";
  readonly targetUrl: string;
  /** Shows the currently inherited target components before interpolation. */
  readonly inheritedTarget: string;
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

export interface RequestRevisionSummary {
  readonly revisionId: EntityId;
  readonly requestId: EntityId;
  readonly name: string | null;
  readonly creationReason: "manual_save" | "execution";
  readonly createdBy: EntityId;
  readonly createdByUsername: string;
  readonly createdAt: string;
}

export interface RequestRevisionView extends RequestRevisionSummary {
  readonly request: RequestView;
}

export interface RequestExecutionInput {
  readonly method: HttpMethod;
  readonly targetMode?: "absolute" | "composed";
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
  readonly targetMode: "absolute" | "composed";
  readonly targetComponents?: readonly string[];
  readonly bodyBytes?: Uint8Array;
  readonly preRequestScript: string;
  readonly postResponseScript: string;
}

export interface PreparedExecution {
  readonly executionId: EntityId;
  readonly revisionId?: EntityId;
  /** Retains templates solely for sensitivity-aware inspection after materialization. */
  readonly templateRequest: ExecutionRequestSnapshot;
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
  readonly target_mode: "absolute" | "composed";
  readonly target_url: string;
  readonly query_mode: "structured";
  readonly query_json: string;
  readonly headers_json: string;
  readonly body_text: string;
  readonly pre_request_script: string;
  readonly post_response_script: string;
  readonly draft_revision: number;
  readonly order_revision: number;
}

/** Stores restorable request-owned content alongside execution-effective headers. */
interface RevisionContent {
  readonly name?: string;
  readonly method: HttpMethod;
  readonly targetMode: "absolute" | "composed";
  readonly targetUrl: string;
  readonly effectiveTargetComponents?: readonly string[];
  readonly queryMode: "structured";
  readonly query: readonly RequestField[];
  readonly headers: readonly RequestField[];
  readonly localHeaders?: readonly RequestField[];
  readonly inheritedHeaders?: readonly RequestField[];
  readonly body: string;
  readonly preRequestScript: string;
  readonly postResponseScript: string;
}

/** Represents the persistence projection required to build a collection view. */
interface CollectionRow {
  readonly id: Uint8Array;
  readonly workspace_id: Uint8Array;
  readonly parent_collection_id: Uint8Array | null;
  readonly name: string;
  readonly profile_revision: number | null;
  readonly headers_json: string | null;
  readonly path_prefix: string | null;
  readonly order_revision: number;
}

/** Identifies one collection subtree node and its dependency deletion depth. */
interface TreeDeletionNode {
  readonly nodeId: EntityId;
  readonly kind: "collection" | "request";
  readonly depth: number;
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
    pathPrefix = "",
  ): Promise<CollectionView> {
    const normalizedName = normalizeName(name);
    const normalizedHeaders = validateHeaders(headers);
    const normalizedPathPrefix = validateCollectionTargetTemplate(pathPrefix);
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
      const pathChanged = (row.path_prefix ?? "") !== normalizedPathPrefix;
      if (!nameChanged && !headersChanged && !pathChanged) {
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
            path_prefix: normalizedPathPrefix,
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
            path_prefix: normalizedPathPrefix,
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
        data: {
          collectionId,
          revision,
          nameChanged,
          headersChanged,
          pathChanged,
        },
      });
      const inheritedHeaders = await this.#resolveHeaders(
        transaction,
        row.workspace_id,
        row.parent_collection_id,
        [],
      );
      return {
        ...mapCollection(row),
        name: normalizedName,
        pathPrefix: normalizedPathPrefix,
        inheritedTarget: await this.#resolveInheritedTarget(
          transaction,
          row.workspace_id,
          row.parent_collection_id,
        ),
        effectivePath: await this.#resolveCollectionPath(
          transaction,
          row.parent_collection_id,
          normalizedPathPrefix,
        ),
        headers: normalizedHeaders,
        inheritedHeaders,
        effectiveHeaders: resolveHeaderLayers([
          inheritedHeaders,
          normalizedHeaders,
        ]),
        revision,
      };
    });
  }

  /** Recursively deletes a collection subtree after a profile revision check. */
  async deleteCollection(
    userId: EntityId,
    collectionId: EntityId,
    expectedRevision: number,
  ): Promise<{ readonly deleted: true }> {
    return this.#database.transaction().execute(async (transaction) => {
      const row = await this.#collectionRow(transaction, collectionId);
      const workspaceId = bytesToId(row.workspace_id);
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      if ((row.profile_revision ?? 0) !== expectedRevision) {
        throw new CollectionProfileConflictError(
          "The collection properties changed",
        );
      }

      const descendants = await this.#collectionDescendants(
        transaction,
        row.workspace_id,
        collectionId,
      );

      const requestIds = descendants
        .filter((node) => node.kind === "request")
        .map((node) => node.nodeId);
      await this.#detachAndDeleteRequestHistory(transaction, requestIds);
      await this.#deleteVariableProfiles(
        transaction,
        userId,
        workspaceId,
        descendants.map((node) => ({
          scopeKind: node.kind,
          scopeId: node.nodeId,
        })),
      );
      for (const node of descendants.sort(
        (left, right) => right.depth - left.depth,
      )) {
        await transaction
          .deleteFrom("workspace_tree_nodes")
          .where("id", "=", idToBytes(node.nodeId))
          .execute();
      }
      const parentCollectionId =
        row.parent_collection_id === null
          ? null
          : bytesToId(row.parent_collection_id);
      const orderRevision = await this.#compactSiblingOrder(
        transaction,
        workspaceId,
        parentCollectionId,
        row.order_revision,
      );
      await this.#audit.record(transaction, {
        type: "collection.deleted",
        actorUserId: userId,
        workspaceId,
        data: {
          collectionId,
          parentCollectionId,
          deletedCollections: descendants.filter(
            (node) => node.kind === "collection",
          ).length,
          deletedRequests: requestIds.length,
          orderRevision,
        },
      });
      return { deleted: true };
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
      row.path_prefix ?? "",
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
    targetMode: "absolute" | "composed" = "absolute",
  ): Promise<RequestView> {
    const content = normalizeExecutionInput({
      method,
      targetMode,
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
          target_mode: content.targetMode,
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
      await this.#ensureRevision(
        transaction,
        await this.#requestRow(transaction, requestId),
        userId,
        "manual_save",
      );
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
        targetMode: content.targetMode,
        targetUrl: content.targetUrl,
        inheritedTarget:
          content.targetMode === "composed"
            ? joinTargetComponents(
                (
                  await this.#targetComponents(
                    transaction,
                    idToBytes(workspaceId),
                    parentCollectionId === null
                      ? null
                      : idToBytes(parentCollectionId),
                    content.targetMode,
                    content.targetUrl,
                  )
                ).slice(0, -1),
              )
            : "",
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

  /** Lists immutable request revisions newest first with optional user names. */
  async listRevisions(
    userId: EntityId,
    requestId: EntityId,
  ): Promise<readonly RequestRevisionSummary[]> {
    const request = await this.#requestRow(this.#database, requestId);
    await this.#workspaces.requireCanRead(
      this.#database,
      userId,
      bytesToId(request.workspace_id),
    );
    const rows = await this.#database
      .selectFrom("request_revisions as revision")
      .innerJoin("users as creator", "creator.id", "revision.created_by")
      .leftJoin(
        "request_versions as version",
        "version.revision_id",
        "revision.id",
      )
      .select([
        "revision.id",
        "revision.creation_reason",
        "revision.created_by",
        "revision.created_at",
        "creator.username",
        "version.name",
      ])
      .where("revision.request_id", "=", idToBytes(requestId))
      .orderBy("revision.created_at", "desc")
      .orderBy("revision.id", "desc")
      .execute();
    return rows.map((row) => ({
      revisionId: bytesToId(row.id),
      requestId,
      name: row.name,
      creationReason: row.creation_reason,
      createdBy: bytesToId(row.created_by),
      createdByUsername: row.username,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  /** Loads one immutable revision as a read-only request projection. */
  async getRevision(
    userId: EntityId,
    requestId: EntityId,
    revisionId: EntityId,
  ): Promise<RequestRevisionView> {
    const row = await this.#requestRow(this.#database, requestId);
    await this.#workspaces.requireCanRead(
      this.#database,
      userId,
      bytesToId(row.workspace_id),
    );
    const revision = await this.#revisionRow(
      this.#database,
      requestId,
      revisionId,
    );
    const content = parseRevisionContent(revision.content_json);
    const [summary] = await this.#revisionSummaries([revisionId], requestId);
    if (summary === undefined) {
      throw new ResourceNotFoundError("Request revision not found");
    }
    return {
      ...summary,
      request: revisionRequestView(row, content),
    };
  }

  /** Adds, changes, or removes the user-facing name for one revision. */
  async nameRevision(
    userId: EntityId,
    requestId: EntityId,
    revisionId: EntityId,
    name: string | null,
  ): Promise<RequestRevisionSummary> {
    return this.#database.transaction().execute(async (transaction) => {
      const request = await this.#requestRow(transaction, requestId);
      const workspaceId = bytesToId(request.workspace_id);
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      await this.#revisionRow(transaction, requestId, revisionId);
      const existing = await transaction
        .selectFrom("request_versions")
        .select(["id", "created_by", "created_at"])
        .where("revision_id", "=", idToBytes(revisionId))
        .executeTakeFirst();
      if (name === null) {
        if (existing !== undefined) {
          await transaction
            .deleteFrom("request_versions")
            .where("id", "=", existing.id)
            .execute();
        }
      } else {
        const normalizedName = normalizeName(name);
        const now = Date.now();
        if (existing === undefined) {
          await transaction
            .insertInto("request_versions")
            .values({
              id: idToBytes(createEntityId()),
              request_id: idToBytes(requestId),
              revision_id: idToBytes(revisionId),
              name: normalizedName,
              name_key: normalizedName.toLocaleLowerCase("en-US"),
              created_by: idToBytes(userId),
              created_at: now,
              updated_by: idToBytes(userId),
              updated_at: now,
            })
            .execute();
        } else {
          await transaction
            .updateTable("request_versions")
            .set({
              name: normalizedName,
              name_key: normalizedName.toLocaleLowerCase("en-US"),
              updated_by: idToBytes(userId),
              updated_at: now,
            })
            .where("id", "=", existing.id)
            .executeTakeFirstOrThrow();
        }
      }
      await this.#audit.record(transaction, {
        type: "request.revision_named",
        actorUserId: userId,
        workspaceId,
        data: { requestId, revisionId, named: name !== null },
      });
      const [summary] = await this.#revisionSummaries(
        [revisionId],
        requestId,
        transaction,
      );
      if (summary === undefined) {
        throw new ResourceNotFoundError("Request revision not found");
      }
      return summary;
    });
  }

  /** Copies immutable revision content into the current mutable draft. */
  async restoreRevision(
    userId: EntityId,
    requestId: EntityId,
    revisionId: EntityId,
    expectedDraftRevision: number,
  ): Promise<RequestView> {
    const revision = await this.#revisionRow(
      this.#database,
      requestId,
      revisionId,
    );
    const content = parseRevisionContent(revision.content_json);
    const current = await this.get(userId, requestId);
    return this.update(
      userId,
      requestId,
      expectedDraftRevision,
      content.name ?? current.name,
      content.method,
      content.targetUrl,
      content.query,
      content.localHeaders ?? current.headers,
      content.body,
      content.preRequestScript,
      content.postResponseScript,
      content.targetMode,
    );
  }

  /** Duplicates a saved request beside its source without copying history. */
  async duplicate(
    userId: EntityId,
    requestId: EntityId,
    name: string,
  ): Promise<RequestView> {
    const normalizedName = normalizeName(name);
    return this.#database.transaction().execute(async (transaction) => {
      const source = await this.#requestRow(transaction, requestId);
      const workspaceId = bytesToId(source.workspace_id);
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      const parentCollectionId =
        source.parent_collection_id === null
          ? null
          : bytesToId(source.parent_collection_id);
      const siblings = await this.#listSiblingOrder(
        transaction,
        workspaceId,
        parentCollectionId,
      );
      const sourceIndex = siblings.findIndex(
        (sibling) => sibling.nodeId === requestId,
      );
      if (sourceIndex < 0) {
        throw new ResourceNotFoundError("Request not found");
      }
      await this.#offsetSiblingPositions(
        transaction,
        workspaceId,
        parentCollectionId,
      );
      const duplicatePosition = await this.#nextPosition(
        transaction,
        workspaceId,
        parentCollectionId,
      );
      const orderRevision =
        siblings.reduce(
          (revision, sibling) => Math.max(revision, sibling.orderRevision),
          0,
        ) + 1;
      const duplicateId = createEntityId();
      const now = Date.now();
      await transaction
        .insertInto("workspace_tree_nodes")
        .values({
          id: idToBytes(duplicateId),
          workspace_id: source.workspace_id,
          parent_collection_id: source.parent_collection_id,
          kind: "request",
          // Existing siblings were moved into a temporary high range above.
          // Allocate the duplicate at a fresh high position too; writing the
          // final contiguous order below must never collide with a live row.
          position: duplicatePosition,
          name: normalizedName,
          order_revision: orderRevision,
          created_at: now,
        })
        .execute();
      await transaction
        .insertInto("request_drafts")
        .values({
          request_id: idToBytes(duplicateId),
          draft_revision: 0,
          method: source.method,
          target_mode: source.target_mode,
          target_url: source.target_url,
          query_mode: source.query_mode,
          query_json: source.query_json,
          headers_json: source.headers_json,
          body_text: source.body_text,
          pre_request_script: source.pre_request_script,
          post_response_script: source.post_response_script,
          updated_by: idToBytes(userId),
          updated_at: now,
        })
        .execute();
      const orderedNodeIds = siblings.map((sibling) => sibling.nodeId);
      orderedNodeIds.splice(sourceIndex + 1, 0, duplicateId);
      for (const [position, nodeId] of orderedNodeIds.entries()) {
        await transaction
          .updateTable("workspace_tree_nodes")
          .set({ position, order_revision: orderRevision })
          .where("id", "=", idToBytes(nodeId))
          .executeTakeFirstOrThrow();
      }
      await this.#variables.cloneRequestProfile(transaction, {
        userId,
        workspaceId,
        sourceRequestId: requestId,
        targetRequestId: duplicateId,
        targetRequestName: normalizedName,
      });
      await this.#audit.record(transaction, {
        type: "request.duplicated",
        actorUserId: userId,
        workspaceId,
        data: {
          requestId: duplicateId,
          sourceRequestId: requestId,
          parentCollectionId,
          orderRevision,
        },
      });
      return this.#requestView(
        transaction,
        await this.#requestRow(transaction, duplicateId),
      );
    });
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
    targetMode: "absolute" | "composed" = "absolute",
  ): Promise<RequestView> {
    const normalizedName = normalizeName(name);
    const content = normalizeExecutionInput({
      method,
      targetMode,
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
        row.target_mode === content.targetMode &&
        row.target_url === content.targetUrl &&
        row.query_json === queryJson &&
        row.headers_json === headersJson &&
        row.body_text === content.body &&
        row.pre_request_script === content.preRequestScript &&
        row.post_response_script === content.postResponseScript
      ) {
        await this.#ensureRevision(transaction, row, userId, "manual_save");
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
          target_mode: content.targetMode,
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
      const updatedView = {
        ...(await this.#requestView(transaction, row)),
        name: normalizedName,
        method: content.method,
        targetMode: content.targetMode,
        targetUrl: content.targetUrl,
        inheritedTarget:
          content.targetMode === "composed"
            ? joinTargetComponents(
                (
                  await this.#targetComponents(
                    transaction,
                    row.workspace_id,
                    row.parent_collection_id,
                    content.targetMode,
                    content.targetUrl,
                  )
                ).slice(0, -1),
              )
            : "",
        query: content.query,
        headers: content.headers,
        body: content.body,
        preRequestScript: content.preRequestScript,
        postResponseScript: content.postResponseScript,
        draftRevision: expectedDraftRevision + 1,
      };
      await this.#ensureRevision(
        transaction,
        {
          ...row,
          name: normalizedName,
          method: content.method,
          target_mode: content.targetMode,
          target_url: content.targetUrl,
          query_json: queryJson,
          headers_json: headersJson,
          body_text: content.body,
          pre_request_script: content.preRequestScript,
          post_response_script: content.postResponseScript,
          draft_revision: expectedDraftRevision + 1,
        },
        userId,
        "manual_save",
      );
      return updatedView;
    });
  }

  /** Deletes a request draft while retaining detached execution snapshots. */
  async delete(
    userId: EntityId,
    requestId: EntityId,
    expectedDraftRevision: number,
  ): Promise<{ readonly deleted: true }> {
    return this.#database.transaction().execute(async (transaction) => {
      const row = await this.#requestRow(transaction, requestId);
      const workspaceId = bytesToId(row.workspace_id);
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      if (row.draft_revision !== expectedDraftRevision) {
        throw new DraftConflictError("The request draft changed");
      }
      await this.#detachAndDeleteRequestHistory(transaction, [requestId]);
      await this.#deleteVariableProfiles(transaction, userId, workspaceId, [
        { scopeKind: "request", scopeId: requestId },
      ]);
      await transaction
        .deleteFrom("workspace_tree_nodes")
        .where("id", "=", idToBytes(requestId))
        .executeTakeFirstOrThrow();
      const parentCollectionId =
        row.parent_collection_id === null
          ? null
          : bytesToId(row.parent_collection_id);
      const orderRevision = await this.#compactSiblingOrder(
        transaction,
        workspaceId,
        parentCollectionId,
        row.order_revision,
      );
      await this.#audit.record(transaction, {
        type: "request.deleted",
        actorUserId: userId,
        workspaceId,
        data: { requestId, parentCollectionId, orderRevision },
      });
      return { deleted: true };
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
      const targetComponents = await this.#targetComponents(
        transaction,
        row.workspace_id,
        row.parent_collection_id,
        request.targetMode,
        request.targetUrl,
      );
      const executionRequest: ExecutionRequestSnapshot = {
        ...request,
        headers: resolvedHeaders,
        targetComponents,
      };
      const eagerlyComposed =
        request.preRequestScript === "" && request.postResponseScript === ""
          ? composeWithVariables(
              executionRequest,
              new VariableResolver(variableProfile.variables),
            )
          : undefined;
      const revisionId = await this.#ensureRevision(
        transaction,
        row,
        userId,
        "execution",
        resolvedHeaders,
        targetComponents,
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
        templateRequest: executionRequest,
        request: eagerlyComposed?.request ?? executionRequest,
        variables: variableProfile.variables,
        variableSources: variableProfile.sources,
        variableEvidence: variableProfile.evidence,
        materialized: eagerlyComposed !== undefined,
        createdAt,
      };
    });
  }

  /** Creates an execution from one immutable revision without changing history. */
  async prepareRevisionExecution(
    userId: EntityId,
    sessionId: EntityId,
    requestId: EntityId,
    revisionId: EntityId,
  ): Promise<PreparedExecution> {
    return this.#database.transaction().execute(async (transaction) => {
      const row = await this.#requestRow(transaction, requestId);
      const workspaceId = bytesToId(row.workspace_id);
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      const revision = await this.#revisionRow(
        transaction,
        requestId,
        revisionId,
      );
      const content = parseRevisionContent(revision.content_json);
      const effectiveHeaders = content.headers;
      const request: ExecutionRequestSnapshot = {
        workspaceId,
        requestId,
        method: content.method,
        targetMode: content.targetMode,
        targetUrl: content.targetUrl,
        targetComponents: content.effectiveTargetComponents ?? [
          content.targetUrl,
        ],
        query: content.query,
        headers: effectiveHeaders,
        body: content.body,
        preRequestScript: content.preRequestScript,
        postResponseScript: content.postResponseScript,
      };
      const variableProfile = await this.#variables.effectiveProfile(
        transaction,
        sessionId,
        workspaceId,
        row.parent_collection_id === null
          ? null
          : bytesToId(row.parent_collection_id),
        requestId,
      );
      const eagerlyComposed =
        request.preRequestScript === "" && request.postResponseScript === ""
          ? composeWithVariables(
              request,
              new VariableResolver(variableProfile.variables),
            )
          : undefined;
      const executionId = createEntityId();
      const createdAt = Date.now();
      await transaction
        .insertInto("executions")
        .values({
          id: idToBytes(executionId),
          workspace_id: idToBytes(workspaceId),
          request_id: idToBytes(requestId),
          request_revision_id: idToBytes(revisionId),
          created_by: idToBytes(userId),
          state: "created",
          snapshot_json: JSON.stringify({
            ...(eagerlyComposed?.persisted ?? request),
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
        workspaceId,
        data: { executionId, requestId, revisionId, historical: true },
      });
      return {
        executionId,
        revisionId,
        templateRequest: request,
        request: eagerlyComposed?.request ?? request,
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
      const targetComponents = await this.#targetComponents(
        transaction,
        idToBytes(workspaceId),
        parentCollectionId === null ? null : idToBytes(parentCollectionId),
        localRequest.targetMode,
        localRequest.targetUrl,
      );
      const variableProfile = await this.#variables.effectiveProfile(
        transaction,
        sessionId,
        workspaceId,
        parentCollectionId,
        null,
      );
      const executionRequest: ExecutionRequestSnapshot = {
        ...localRequest,
        headers: resolvedHeaders,
        targetComponents,
      };
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
        templateRequest: executionRequest,
        request: eagerlyComposed?.request ?? executionRequest,
        variables: variableProfile.variables,
        variableSources: variableProfile.sources,
        variableEvidence: variableProfile.evidence,
        materialized: eagerlyComposed !== undefined,
        createdAt,
      };
    });
  }

  /** Reuses matching content or appends one immutable request revision. */
  async #ensureRevision(
    transaction: Transaction<DatabaseSchema>,
    row: RequestRow,
    userId: EntityId,
    creationReason: "manual_save" | "execution",
    effectiveHeaders?: readonly RequestField[],
    effectiveTargetComponents?: readonly string[],
  ): Promise<EntityId> {
    const localHeaders = validateHeaders(
      JSON.parse(row.headers_json) as RequestField[],
    );
    const inheritedHeaders = await this.#resolveHeaders(
      transaction,
      row.workspace_id,
      row.parent_collection_id,
      [],
    );
    const resolvedHeaders =
      effectiveHeaders ?? resolveHeaderLayers([inheritedHeaders, localHeaders]);
    const targetComponents =
      effectiveTargetComponents ??
      (await this.#targetComponents(
        transaction,
        row.workspace_id,
        row.parent_collection_id,
        row.target_mode,
        row.target_url,
      ));
    const content = JSON.stringify(
      revisionContent(row, resolvedHeaders, inheritedHeaders, targetComponents),
    );
    const fingerprint = createHash("sha256").update(content).digest("hex");
    const latest = await transaction
      .selectFrom("request_revisions")
      .select(["id", "content_fingerprint"])
      .where("request_id", "=", row.request_id)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    if (latest?.content_fingerprint === fingerprint) {
      return bytesToId(latest.id);
    }
    const revisionId = createEntityId();
    await transaction
      .insertInto("request_revisions")
      .values({
        id: idToBytes(revisionId),
        request_id: row.request_id,
        parent_revision_id: latest === undefined ? null : latest.id,
        creation_reason: creationReason,
        created_by: idToBytes(userId),
        created_at: Date.now(),
        content_json: content,
        content_fingerprint: fingerprint,
      })
      .execute();
    return revisionId;
  }

  /** Loads an immutable revision only when it belongs to the named request. */
  async #revisionRow(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    requestId: EntityId,
    revisionId: EntityId,
  ) {
    const row = await database
      .selectFrom("request_revisions")
      .selectAll()
      .where("id", "=", idToBytes(revisionId))
      .where("request_id", "=", idToBytes(requestId))
      .executeTakeFirst();
    if (row === undefined) {
      throw new ResourceNotFoundError("Request revision not found");
    }
    return row;
  }

  /** Loads public summaries for a bounded set of already authorized revisions. */
  async #revisionSummaries(
    revisionIds: readonly EntityId[],
    requestId: EntityId,
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema> = this
      .#database,
  ): Promise<readonly RequestRevisionSummary[]> {
    if (revisionIds.length === 0) return [];
    const rows = await database
      .selectFrom("request_revisions as revision")
      .innerJoin("users as creator", "creator.id", "revision.created_by")
      .leftJoin(
        "request_versions as version",
        "version.revision_id",
        "revision.id",
      )
      .select([
        "revision.id",
        "revision.creation_reason",
        "revision.created_by",
        "revision.created_at",
        "creator.username",
        "version.name",
      ])
      .where("revision.request_id", "=", idToBytes(requestId))
      .where("revision.id", "in", revisionIds.map(idToBytes))
      .execute();
    const byId = new Map(rows.map((row) => [bytesToId(row.id), row] as const));
    return revisionIds.flatMap((revisionId) => {
      const row = byId.get(revisionId);
      return row === undefined
        ? []
        : [
            {
              revisionId,
              requestId,
              name: row.name,
              creationReason: row.creation_reason,
              createdBy: bytesToId(row.created_by),
              createdByUsername: row.username,
              createdAt: new Date(row.created_at).toISOString(),
            },
          ];
    });
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
        "node.order_revision",
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
        "profile.path_prefix",
        "node.order_revision",
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
    const inheritedHeaders = await this.#resolveHeaders(
      database,
      row.workspace_id,
      row.parent_collection_id,
      [],
    );
    return {
      ...collection,
      inheritedTarget: await this.#resolveInheritedTarget(
        database,
        row.workspace_id,
        row.parent_collection_id,
      ),
      effectivePath: await this.#resolveCollectionPath(
        database,
        row.parent_collection_id,
        collection.pathPrefix,
      ),
      inheritedHeaders,
      effectiveHeaders: resolveHeaderLayers([
        inheritedHeaders,
        collection.headers,
      ]),
    };
  }

  /** Returns a request's absolute component or composed root-to-leaf parts. */
  async #targetComponents(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    workspaceId: Uint8Array,
    parentCollectionId: Uint8Array | null,
    targetMode: "absolute" | "composed",
    requestTarget: string,
  ): Promise<readonly string[]> {
    if (targetMode === "absolute") return [requestTarget];
    const workspace = await database
      .selectFrom("workspaces")
      .select("base_url_template")
      .where("id", "=", workspaceId)
      .executeTakeFirst();
    if (workspace === undefined) {
      throw new ResourceNotFoundError("Workspace not found");
    }
    return [
      workspace.base_url_template,
      ...(await this.#collectionPathParts(database, parentCollectionId)),
      requestTarget,
    ];
  }

  /** Resolves local collection prefixes in deterministic root-to-leaf order. */
  async #collectionPathParts(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    collectionId: Uint8Array | null,
  ): Promise<string[]> {
    const parts: string[] = [];
    const visited = new Set<string>();
    let currentId = collectionId;
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
        .select(["node.parent_collection_id", "profile.path_prefix"])
        .where("node.id", "=", currentId)
        .where("node.kind", "=", "collection")
        .executeTakeFirst();
      if (row === undefined) {
        throw new ResourceNotFoundError("Parent collection not found");
      }
      parts.unshift(row.path_prefix ?? "");
      currentId = row.parent_collection_id;
    }
    return parts;
  }

  /** Joins collection target components for an effective-prefix view. */
  async #resolveCollectionPath(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    parentCollectionId: Uint8Array | null,
    localPath: string,
  ): Promise<string> {
    return joinTargetComponents([
      ...(await this.#collectionPathParts(database, parentCollectionId)),
      localPath,
    ]);
  }

  /** Joins the workspace and ancestor targets before one local component. */
  async #resolveInheritedTarget(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    workspaceId: Uint8Array,
    parentCollectionId: Uint8Array | null,
  ): Promise<string> {
    return joinTargetComponents(
      (
        await this.#targetComponents(
          database,
          workspaceId,
          parentCollectionId,
          "composed",
          "",
        )
      ).slice(0, -1),
    );
  }

  /** Builds a request view with effective collection headers kept read-only. */
  async #requestView(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    row: RequestRow,
  ): Promise<RequestView> {
    const request = mapRequest(row);
    return {
      ...request,
      inheritedTarget:
        request.targetMode === "composed"
          ? await this.#resolveInheritedTarget(
              database,
              row.workspace_id,
              row.parent_collection_id,
            )
          : "",
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

  /** Detaches durable executions before removing mutable request history. */
  async #detachAndDeleteRequestHistory(
    transaction: Transaction<DatabaseSchema>,
    requestIds: readonly EntityId[],
  ): Promise<void> {
    if (requestIds.length === 0) return;
    const persistedIds = requestIds.map(idToBytes);
    await transaction
      .updateTable("executions")
      .set({ request_id: null, request_revision_id: null })
      .where("request_id", "in", persistedIds)
      .execute();
    await transaction
      .updateTable("request_revisions")
      .set({ parent_revision_id: null })
      .where("request_id", "in", persistedIds)
      .execute();
    await transaction
      .deleteFrom("request_revisions")
      .where("request_id", "in", persistedIds)
      .execute();
  }

  /** Resolves a complete collection subtree for deepest-first deletion. */
  async #collectionDescendants(
    transaction: Transaction<DatabaseSchema>,
    workspaceId: Uint8Array,
    collectionId: EntityId,
  ): Promise<TreeDeletionNode[]> {
    const persistedNodes = await transaction
      .selectFrom("workspace_tree_nodes")
      .select(["id", "parent_collection_id", "kind"])
      .where("workspace_id", "=", workspaceId)
      .execute();
    const nodes = new Map(
      persistedNodes.map((node) => [bytesToId(node.id), node] as const),
    );
    const children = new Map<EntityId, EntityId[]>();
    for (const node of persistedNodes) {
      if (node.parent_collection_id === null) continue;
      const parentId = bytesToId(node.parent_collection_id);
      children.set(parentId, [
        ...(children.get(parentId) ?? []),
        bytesToId(node.id),
      ]);
    }
    const descendants: TreeDeletionNode[] = [];
    const pending = [{ nodeId: collectionId, depth: 0 }];
    const visited = new Set<EntityId>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || visited.has(current.nodeId)) continue;
      visited.add(current.nodeId);
      const node = nodes.get(current.nodeId);
      if (node === undefined) {
        throw new ResourceNotFoundError("Collection not found");
      }
      descendants.push({
        nodeId: current.nodeId,
        kind: node.kind,
        depth: current.depth,
      });
      for (const childId of children.get(current.nodeId) ?? []) {
        pending.push({ nodeId: childId, depth: current.depth + 1 });
      }
    }
    return descendants;
  }

  /** Deletes current variable profiles and audits secret-version removal. */
  async #deleteVariableProfiles(
    transaction: Transaction<DatabaseSchema>,
    userId: EntityId,
    workspaceId: EntityId,
    scopes: readonly {
      readonly scopeKind: "collection" | "request";
      readonly scopeId: EntityId;
    }[],
  ): Promise<void> {
    if (scopes.length === 0) return;
    const scopeIds = scopes.map((scope) => idToBytes(scope.scopeId));
    const secrets = await transaction
      .selectFrom("variable_profiles as profile")
      .innerJoin("variables as variable", "variable.profile_id", "profile.id")
      .innerJoin(
        "variable_secrets as secret",
        "secret.variable_id",
        "variable.id",
      )
      .select([
        "profile.scope_kind",
        "profile.scope_id",
        "variable.id as variable_id",
        "secret.version",
      ])
      .where("profile.scope_kind", "in", ["collection", "request"])
      .where("profile.scope_id", "in", scopeIds)
      .execute();
    await transaction
      .deleteFrom("variable_profiles")
      .where("scope_kind", "in", ["collection", "request"])
      .where("scope_id", "in", scopeIds)
      .execute();
    for (const secret of secrets) {
      await this.#audit.record(transaction, {
        type: "secret_variable.deleted",
        actorUserId: userId,
        workspaceId,
        data: {
          scopeKind: secret.scope_kind,
          scopeId: bytesToId(secret.scope_id),
          variableId: bytesToId(secret.variable_id),
          secretVersion: secret.version,
        },
      });
    }
  }

  /** Compacts a sibling list and advances its optimistic ordering revision. */
  async #compactSiblingOrder(
    transaction: Transaction<DatabaseSchema>,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
    deletedOrderRevision: number,
  ): Promise<number> {
    const siblings = await this.#listSiblingOrder(
      transaction,
      workspaceId,
      parentCollectionId,
    );
    const orderRevision =
      siblings.reduce(
        (revision, sibling) => Math.max(revision, sibling.orderRevision),
        deletedOrderRevision,
      ) + 1;
    for (const [position, sibling] of siblings.entries()) {
      await transaction
        .updateTable("workspace_tree_nodes")
        .set({ position, order_revision: orderRevision })
        .where("id", "=", idToBytes(sibling.nodeId))
        .executeTakeFirstOrThrow();
    }
    return orderRevision;
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

/** Accepts an absolute base template or a path contributed by a collection. */
function validateCollectionTargetTemplate(value: string): string {
  return value.includes("://")
    ? validateBaseUrlTemplate(value)
    : validatePathTemplate(value);
}

/** Validates a composed-request path template without URL data. */
function validatePathTemplate(value: string): string {
  if (
    value.length > 8192 ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    value.includes("://") ||
    value.startsWith("//") ||
    containsControlCharacter(value) ||
    /%(?![\dA-Fa-f]{2})/u.test(value)
  ) {
    throw new Error("Path template is invalid");
  }
  return value;
}

/** Detects prohibited ASCII controls without embedding them in a regexp. */
function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

/** Validates one persisted immutable target component defensively. */
function validateTargetComponentSnapshot(value: string): string {
  if (typeof value !== "string" || value.length > 8192) {
    throw new Error("Revision target component is invalid");
  }
  return value;
}

/** Joins non-empty target components with one slash at each boundary. */
export function joinTargetComponents(components: readonly string[]): string {
  const nonEmpty = components.filter((component) => component !== "");
  return nonEmpty.reduce((joined, component, index) => {
    if (index === 0) return component;
    return `${joined.replace(/\/+$/u, "")}/${component.replace(/^\/+/u, "")}`;
  }, "");
}

/** Requires the first resolved component to establish an absolute target. */
function composeResolvedTargetComponents(
  components: readonly string[],
): string {
  const nonEmpty = components.filter((component) => component !== "");
  const base = nonEmpty[0];
  if (base === undefined) {
    throw new Error("Composed target has no absolute base URL");
  }
  validateTargetUrl(base);
  for (const path of nonEmpty.slice(1)) {
    validatePathTemplate(path);
  }
  return validateTargetUrl(joinTargetComponents(nonEmpty));
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
      typeof field.enabled !== "boolean" ||
      (field.mode !== undefined &&
        field.mode !== "override" &&
        field.mode !== "append")
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
    return {
      name: field.name,
      value: field.value,
      enabled: field.enabled,
      mode: field.mode ?? "override",
    };
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
function normalizeExecutionInput(input: RequestExecutionInput): Omit<
  RequestExecutionInput,
  "targetMode"
> & {
  readonly targetMode: "absolute" | "composed";
  readonly preRequestScript: string;
  readonly postResponseScript: string;
} {
  return {
    method: validateMethod(input.method),
    targetMode: input.targetMode ?? "absolute",
    targetUrl:
      (input.targetMode ?? "absolute") === "composed"
        ? validatePathTemplate(input.targetUrl)
        : validateTargetTemplate(input.targetUrl),
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
  const targetParts = (request.targetComponents ?? [request.targetUrl]).map(
    (component) => resolver.interpolate(component),
  );
  for (const component of targetParts) retain(component.secretReferences);
  const targetValue =
    request.targetMode === "composed"
      ? composeResolvedTargetComponents(
          targetParts.map((component) => component.value),
        )
      : (targetParts[0]?.value ?? "");
  const targetSecret = targetParts.some((component) => component.secret);
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
    targetMode: "absolute",
    targetUrl: validateTargetUrl(targetValue),
    query: validateQuery(query.map((field) => field.materialized)),
    headers: validateHeaders(headers.map((field) => field.materialized)),
    body: body === null ? "" : validateBody(body.value),
  };
  return {
    request: materialized,
    persisted: {
      method: materialized.method,
      targetMode: "absolute",
      targetUrl: targetSecret ? "[secret]" : materialized.targetUrl,
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
  readonly target_mode: "absolute" | "composed";
  readonly target_url: string;
  readonly query_mode: "structured";
  readonly query_json: string;
  readonly headers_json: string;
  readonly body_text: string;
  readonly pre_request_script: string;
  readonly post_response_script: string;
  readonly draft_revision: number;
}): Omit<RequestView, "inheritedHeaders" | "inheritedTarget"> {
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

/** Serializes request-owned revision content plus optional effective headers. */
function revisionContent(
  row: RequestRow,
  effectiveHeaders: readonly RequestField[],
  inheritedHeaders: readonly RequestField[],
  effectiveTargetComponents: readonly string[],
): RevisionContent {
  const request = mapRequest(row);
  return {
    name: request.name,
    method: request.method,
    targetMode: request.targetMode,
    targetUrl: request.targetUrl,
    effectiveTargetComponents,
    queryMode: request.queryMode,
    query: request.query,
    headers: effectiveHeaders,
    localHeaders: request.headers,
    inheritedHeaders,
    body: request.body,
    preRequestScript: request.preRequestScript,
    postResponseScript: request.postResponseScript,
  };
}

/** Parses and validates persisted revision content at the storage boundary. */
function parseRevisionContent(value: string): RevisionContent {
  const parsed = JSON.parse(value) as Partial<RevisionContent>;
  const normalized = normalizeExecutionInput({
    method: validateMethod(parsed.method ?? ""),
    targetMode: parsed.targetMode ?? "absolute",
    targetUrl: parsed.targetUrl ?? "",
    query: parsed.query ?? [],
    headers: parsed.headers ?? [],
    body: parsed.body ?? "",
    preRequestScript: parsed.preRequestScript ?? "",
    postResponseScript: parsed.postResponseScript ?? "",
  });
  return {
    ...(parsed.name === undefined ? {} : { name: normalizeName(parsed.name) }),
    method: normalized.method,
    targetMode: normalized.targetMode,
    targetUrl: normalized.targetUrl,
    ...(parsed.effectiveTargetComponents === undefined
      ? {}
      : {
          effectiveTargetComponents: parsed.effectiveTargetComponents.map(
            validateTargetComponentSnapshot,
          ),
        }),
    queryMode: "structured",
    query: normalized.query,
    headers: normalized.headers,
    ...(parsed.localHeaders === undefined
      ? {}
      : { localHeaders: validateHeaders(parsed.localHeaders) }),
    ...(parsed.inheritedHeaders === undefined
      ? {}
      : { inheritedHeaders: validateHeaders(parsed.inheritedHeaders) }),
    body: normalized.body,
    preRequestScript: normalized.preRequestScript,
    postResponseScript: normalized.postResponseScript,
  };
}

/** Projects immutable content onto request identity for read-only editing UI. */
function revisionRequestView(
  row: RequestRow,
  content: RevisionContent,
): RequestView {
  const current = mapRequest(row);
  const localHeaders = content.localHeaders ?? current.headers;
  const localHeaderNames = new Set(
    localHeaders
      .filter((header) => header.enabled)
      .map((header) => header.name.toLowerCase()),
  );
  return {
    ...current,
    name: content.name ?? current.name,
    method: content.method,
    targetMode: content.targetMode,
    targetUrl: content.targetUrl,
    inheritedTarget:
      content.targetMode === "composed"
        ? joinTargetComponents(
            (content.effectiveTargetComponents ?? []).slice(0, -1),
          )
        : "",
    query: content.query,
    headers: localHeaders,
    inheritedHeaders:
      content.inheritedHeaders ??
      (content.localHeaders === undefined
        ? []
        : content.headers.filter(
            (header) => !localHeaderNames.has(header.name.toLowerCase()),
          )),
    body: content.body,
    preRequestScript: content.preRequestScript,
    postResponseScript: content.postResponseScript,
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
  readonly path_prefix: string | null;
}): Omit<
  CollectionView,
  "inheritedTarget" | "inheritedHeaders" | "effectiveHeaders" | "effectivePath"
> {
  return {
    collectionId: bytesToId(row.id),
    workspaceId: bytesToId(row.workspace_id),
    parentCollectionId:
      row.parent_collection_id === null
        ? null
        : bytesToId(row.parent_collection_id),
    name: row.name,
    pathPrefix: row.path_prefix ?? "",
    headers: JSON.parse(row.headers_json ?? "[]") as RequestField[],
    revision: row.profile_revision ?? 0,
  };
}

/** Resolves enabled header groups according to each layer's persisted merge modes. */
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
      if (group.some((field) => (field.mode ?? "override") === "override")) {
        resolved = resolved.filter((field) => field.name.toLowerCase() !== key);
      }
      resolved.push(...group);
    }
  }
  return resolved;
}
