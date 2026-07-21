import type { Kysely } from "kysely";

import type { components as ProxyComponents } from "@apinteract/api-contracts/proxy";

import type { AuditService } from "../audit/audit-service.js";
import {
  type LocalBlobStore,
  type LocalBlobWriter,
  type StoredBlob,
} from "../blobs/local-blob-store.js";
import { bytesToId, idToBytes, type EntityId } from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";
import type { ProxyClient } from "../proxy/proxy-client.js";
import { ProxyExecutionError } from "../proxy/proxy-client.js";
import type {
  RequestService,
  PreparedExecution,
} from "../requests/request-service.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";
import { ResourceNotFoundError } from "../workspaces/workspace-service.js";

type ResponseHead = ProxyComponents["schemas"]["ResponseHead"];
type ResponseComplete = ProxyComponents["schemas"]["ResponseComplete"];

export interface ExecutionEvent {
  readonly type:
    | "execution.progress"
    | "execution.response_head"
    | "execution.completed"
    | "execution.failed";
  readonly executionId: EntityId;
  readonly payload: unknown;
}

export interface ExecutionView {
  readonly executionId: EntityId;
  readonly requestId: EntityId;
  readonly state: "created" | "running" | "completed" | "failed";
  readonly status?: number;
  readonly headers?: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly bodyComplete: boolean;
  readonly bodyBytes?: number;
  readonly bodySha256?: string;
  readonly bodyPreview?: string;
  readonly bodyBlobId?: EntityId;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly errors: readonly [];
  };
}

export interface ExecutionBody {
  readonly storageKey: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/**
 * Orchestrates a saved request through the proxy and persists its response.
 *
 * Starting an execution returns after durable preparation; response processing
 * continues asynchronously and reports progress through the supplied event
 * publisher. Complete and partial response bytes use the same blob lifecycle.
 */
export class ExecutionService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #requests: RequestService;
  readonly #workspaces: WorkspaceService;
  readonly #proxy: ProxyClient;
  readonly #blobs: LocalBlobStore;
  readonly #audit: AuditService;

  constructor(
    database: Kysely<DatabaseSchema>,
    requests: RequestService,
    workspaces: WorkspaceService,
    proxy: ProxyClient,
    blobs: LocalBlobStore,
    audit: AuditService,
  ) {
    this.#database = database;
    this.#requests = requests;
    this.#workspaces = workspaces;
    this.#proxy = proxy;
    this.#blobs = blobs;
    this.#audit = audit;
  }

  /** Starts asynchronous proxy execution and returns its initial running view. */
  async start(
    userId: EntityId,
    requestId: EntityId,
    publish: (event: ExecutionEvent) => void,
  ): Promise<ExecutionView> {
    const prepared = await this.#requests.prepareExecution(userId, requestId);
    await this.#database
      .updateTable("executions")
      .set({ state: "running" })
      .where("id", "=", idToBytes(prepared.executionId))
      .execute();
    // The caller receives the running view immediately. Terminal state arrives
    // through execution events after proxy streaming and persistence finish.
    void this.#run(prepared, userId, publish);
    return {
      executionId: prepared.executionId,
      requestId,
      state: "running",
      bodyComplete: false,
      createdAt: new Date(prepared.createdAt).toISOString(),
    };
  }

  /** Resolves authorized immutable response-body metadata for an execution. */
  async getBody(
    userId: EntityId,
    executionId: EntityId,
  ): Promise<ExecutionBody> {
    const row = await this.#database
      .selectFrom("executions as execution")
      .innerJoin(
        "workspace_tree_nodes as node",
        "node.id",
        "execution.request_id",
      )
      .innerJoin("blobs as blob", "blob.id", "execution.response_blob_id")
      .select([
        "node.workspace_id",
        "blob.storage_key",
        "blob.byte_length",
        "blob.sha256",
      ])
      .where("execution.id", "=", idToBytes(executionId))
      .executeTakeFirst();
    if (row === undefined) {
      throw new ResourceNotFoundError("Execution body not found");
    }
    await this.#workspaces.requireCanRead(
      this.#database,
      userId,
      bytesToId(row.workspace_id),
    );
    return {
      storageKey: row.storage_key,
      byteLength: row.byte_length,
      sha256: row.sha256,
    };
  }

  /** Opens a previously authorized response body from blob storage. */
  openBody(storageKey: string) {
    return this.#blobs.open(storageKey);
  }

  /** Streams a prepared request through the proxy into terminal persistence. */
  async #run(
    prepared: PreparedExecution,
    userId: EntityId,
    publish: (event: ExecutionEvent) => void,
  ): Promise<void> {
    const writer = this.#blobs.createWriter();
    let head: ResponseHead | undefined;
    try {
      // Sink callbacks are awaited by ProxyClient, so filesystem writes apply
      // backpressure to the proxy response stream.
      await this.#proxy.executeGet(
        prepared.executionId,
        prepared.request.targetUrl,
        {
          responseHead: async (value) => {
            head = value;
            await this.#database
              .updateTable("executions")
              .set({
                response_status: value.status,
                response_headers_json: JSON.stringify(value.headers),
              })
              .where("id", "=", idToBytes(prepared.executionId))
              .execute();
            publish({
              type: "execution.response_head",
              executionId: prepared.executionId,
              payload: { status: value.status, headers: value.headers },
            });
          },
          body: async (bytes) => {
            await writer.write(bytes);
            publish({
              type: "execution.progress",
              executionId: prepared.executionId,
              payload: { bodyBytes: writer.byteLength },
            });
          },
          complete: async (value) => {
            await this.#complete(
              prepared,
              userId,
              writer,
              head,
              value,
              publish,
            );
          },
        },
      );
    } catch (cause) {
      await this.#fail(prepared, userId, writer, head, cause, publish);
    }
  }

  /** Validates and commits a complete proxy response and its blob metadata. */
  async #complete(
    prepared: PreparedExecution,
    userId: EntityId,
    writer: LocalBlobWriter,
    head: ResponseHead | undefined,
    complete: ResponseComplete,
    publish: (event: ExecutionEvent) => void,
  ): Promise<void> {
    if (head === undefined) {
      throw new Error("Proxy completed without a response head");
    }
    const blob = await writer.commit();
    // Verify the locally persisted bytes before making the response visible as
    // complete. A mismatch is retained as a failed partial response.
    if (
      blob.byteLength !== complete.bodyBytes ||
      (complete.bodySha256 !== null && blob.sha256 !== complete.bodySha256)
    ) {
      throw new Error(
        "Stored response body does not match proxy completion metadata",
      );
    }
    const view = await this.#persistTerminal(
      prepared,
      userId,
      blob,
      head,
      true,
      null,
    );
    publish({
      type: "execution.completed",
      executionId: prepared.executionId,
      payload: view,
    });
  }

  /** Preserves any received bytes and records a failed partial response. */
  async #fail(
    prepared: PreparedExecution,
    userId: EntityId,
    writer: LocalBlobWriter,
    head: ResponseHead | undefined,
    cause: unknown,
    publish: (event: ExecutionEvent) => void,
  ): Promise<void> {
    let blob: StoredBlob | undefined;
    try {
      // Bytes received before a network or proxy failure remain useful for
      // diagnosis and are modeled explicitly as a partial response blob.
      blob = await writer.commit();
    } catch {
      await writer.abort();
    }
    const error = toExecutionError(cause);
    const view = await this.#persistTerminal(
      prepared,
      userId,
      blob,
      head,
      false,
      error,
    );
    publish({
      type: "execution.failed",
      executionId: prepared.executionId,
      payload: view,
    });
  }

  /** Atomically records blob metadata, terminal state, and the audit event. */
  async #persistTerminal(
    prepared: PreparedExecution,
    userId: EntityId,
    blob: StoredBlob | undefined,
    head: ResponseHead | undefined,
    bodyComplete: boolean,
    error: { readonly code: string; readonly message: string } | null,
  ): Promise<ExecutionView> {
    const completedAt = Date.now();
    // The file is committed before this transaction. Blob metadata, its
    // execution reference, terminal state, and audit outbox entry are then
    // committed atomically. Crash recovery may need to remove an orphan file
    // that was renamed before this transaction began.
    await this.#database.transaction().execute(async (transaction) => {
      if (blob !== undefined) {
        await transaction
          .insertInto("blobs")
          .values({
            id: idToBytes(blob.id),
            provider_id: "local-filesystem",
            storage_key: blob.storageKey,
            state: bodyComplete ? "available" : "partial",
            purpose: "execution_response",
            byte_length: blob.byteLength,
            sha256: blob.sha256,
            created_at: completedAt,
          })
          .execute();
        await transaction
          .insertInto("blob_references")
          .values({
            blob_id: idToBytes(blob.id),
            owner_kind: "execution_response",
            owner_id: idToBytes(prepared.executionId),
            created_at: completedAt,
          })
          .execute();
      }
      await transaction
        .updateTable("executions")
        .set({
          state: bodyComplete ? "completed" : "failed",
          response_status: head?.status ?? null,
          response_headers_json:
            head === undefined ? null : JSON.stringify(head.headers),
          response_blob_id: blob === undefined ? null : idToBytes(blob.id),
          body_complete: bodyComplete ? 1 : 0,
          body_bytes: blob?.byteLength ?? 0,
          body_sha256: blob?.sha256 ?? null,
          error_json: error === null ? null : JSON.stringify(error),
          completed_at: completedAt,
        })
        .where("id", "=", idToBytes(prepared.executionId))
        .execute();
      await this.#audit.record(transaction, {
        type: bodyComplete ? "execution.completed" : "execution.failed",
        actorUserId: userId,
        workspaceId: prepared.request.workspaceId,
        data: {
          executionId: prepared.executionId,
          requestId: prepared.request.requestId,
          bodyComplete,
          bodyBytes: blob?.byteLength ?? 0,
          errorCode: error?.code,
        },
      });
    });

    const preview =
      blob === undefined || head === undefined
        ? undefined
        : safeTextPreview(head.headers, blob.previewBytes);
    return {
      executionId: prepared.executionId,
      requestId: prepared.request.requestId,
      state: bodyComplete ? "completed" : "failed",
      ...(head === undefined
        ? {}
        : { status: head.status, headers: head.headers }),
      bodyComplete,
      bodyBytes: blob?.byteLength ?? 0,
      ...(blob === undefined
        ? {}
        : { bodySha256: blob.sha256, bodyBlobId: blob.id }),
      ...(preview === undefined ? {} : { bodyPreview: preview }),
      createdAt: new Date(prepared.createdAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      ...(error === null ? {} : { error: { ...error, errors: [] as const } }),
    };
  }
}

/** Maps proxy and internal failures to a stable execution error contract. */
function toExecutionError(cause: unknown): {
  readonly code: string;
  readonly message: string;
} {
  if (cause instanceof ProxyExecutionError) {
    return { code: cause.detail.code, message: cause.detail.message };
  }
  return {
    code: "execution_failed",
    message: cause instanceof Error ? cause.message : "Execution failed",
  };
}

/** Decodes a bounded preview only when headers identify valid UTF-8 text. */
function safeTextPreview(
  headers: readonly { readonly name: string; readonly value: string }[],
  bytes: Buffer,
): string | undefined {
  // Preview only media types that are conventionally textual. Invalid UTF-8
  // remains available as raw blob bytes and is not replaced or decoded loosely.
  const contentType = headers
    .find((header) => header.name.toLowerCase() === "content-type")
    ?.value.toLowerCase();
  const textLike =
    contentType?.startsWith("text/") === true ||
    contentType?.includes("json") === true ||
    contentType?.includes("xml") === true ||
    contentType?.includes("javascript") === true;
  if (!textLike) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
