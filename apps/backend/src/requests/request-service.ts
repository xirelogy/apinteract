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
  readonly draftRevision: number;
}

export interface RequestExecutionInput {
  readonly method: HttpMethod;
  readonly targetUrl: string;
  readonly query: readonly RequestField[];
  readonly headers: readonly RequestField[];
  readonly body: string;
}

export interface ExecutionRequestSnapshot extends RequestExecutionInput {
  readonly workspaceId: EntityId;
  readonly requestId?: EntityId;
}

export interface PreparedExecution {
  readonly executionId: EntityId;
  readonly revisionId?: EntityId;
  readonly request: ExecutionRequestSnapshot;
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
      .leftJoin("request_drafts", "request_drafts.request_id", "id")
      .select(["id", "kind", "name", "position", "request_drafts.method"])
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
      ...(row.method === null ? {} : { method: row.method }),
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

  /** Replaces a collection's common headers using optimistic concurrency. */
  async updateCollectionHeaders(
    userId: EntityId,
    collectionId: EntityId,
    expectedRevision: number,
    headers: readonly RequestField[],
  ): Promise<CollectionView> {
    const normalizedHeaders = validateHeaders(headers);
    const headersJson = JSON.stringify(normalizedHeaders);
    return this.#database.transaction().execute(async (transaction) => {
      const row = await this.#collectionRow(transaction, collectionId);
      const workspaceId = bytesToId(row.workspace_id);
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      const currentRevision = row.profile_revision ?? 0;
      if (currentRevision !== expectedRevision) {
        throw new CollectionProfileConflictError(
          "The collection header profile changed",
        );
      }
      if ((row.headers_json ?? "[]") === headersJson) {
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
            "The collection header profile changed",
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
            "The collection header profile changed",
          );
        }
      }
      await this.#audit.record(transaction, {
        type: "collection.headers_updated",
        actorUserId: userId,
        workspaceId,
        data: { collectionId, revision },
      });
      return {
        ...mapCollection(row),
        headers: normalizedHeaders,
        effectiveHeaders: await this.#resolveHeaders(
          transaction,
          row.parent_collection_id,
          normalizedHeaders,
        ),
        revision,
      };
    });
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
  ): Promise<RequestView> {
    const content = normalizeExecutionInput({
      method,
      targetUrl,
      query,
      headers,
      body,
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
          order_revision: 0,
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
  ): Promise<RequestView> {
    const normalizedName = normalizeName(name);
    const content = normalizeExecutionInput({
      method,
      targetUrl,
      query,
      headers,
      body,
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
        row.body_text === content.body
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
      const resolvedHeaders = await this.#resolveHeaders(
        transaction,
        row.parent_collection_id,
        request.headers,
      );
      const resolvedRequest = { ...request, headers: resolvedHeaders };
      const content = JSON.stringify({
        method: request.method,
        targetMode: request.targetMode,
        targetUrl: request.targetUrl,
        queryMode: request.queryMode,
        query: request.query,
        headers: resolvedHeaders,
        body: request.body,
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
      return { executionId, revisionId, request: resolvedRequest, createdAt };
    });
  }

  /** Creates a durable workspace-owned execution without saving a request. */
  async prepareTemporaryExecution(
    userId: EntityId,
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
        parentCollectionId === null ? null : idToBytes(parentCollectionId),
        localRequest.headers,
      );
      const request = { ...localRequest, headers: resolvedHeaders };
      const executionId = createEntityId();
      const createdAt = Date.now();
      const snapshot = JSON.stringify({
        method: request.method,
        targetMode: "absolute",
        targetUrl: request.targetUrl,
        queryMode: "structured",
        query: request.query,
        headers: request.headers,
        body: request.body,
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
          created_at: createdAt,
          completed_at: null,
        })
        .execute();
      await this.#audit.record(transaction, {
        type: "execution.created",
        actorUserId: userId,
        workspaceId,
        data: { executionId, requestId: null, revisionId: null },
      });
      return { executionId, request, createdAt };
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
        row.parent_collection_id,
        [],
      ),
    };
  }

  /** Resolves collection header layers root-first and overlays request headers. */
  async #resolveHeaders(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    parentCollectionId: Uint8Array | null,
    requestHeaders: readonly RequestField[],
  ): Promise<RequestField[]> {
    const layers: RequestField[][] = [];
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
      layers.unshift(
        validateHeaders(
          JSON.parse(row.headers_json ?? "[]") as readonly RequestField[],
        ),
      );
      currentId = row.parent_collection_id;
    }
    return resolveHeaderLayers([...layers, validateHeaders(requestHeaders)]);
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

/** Normalizes and validates content shared by saved and temporary executions. */
function normalizeExecutionInput(
  input: RequestExecutionInput,
): RequestExecutionInput {
  return {
    method: validateMethod(input.method),
    targetUrl: validateTargetUrl(input.targetUrl),
    query: validateQuery(input.query),
    headers: validateHeaders(input.headers),
    body: validateBody(input.body),
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
