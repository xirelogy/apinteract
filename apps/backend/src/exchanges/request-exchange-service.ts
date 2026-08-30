import type { Kysely } from "kysely";

import type { LocalBlobStore } from "../blobs/local-blob-store.js";
import {
  safeUtf8Preview,
  type ExecutionView,
} from "../executions/execution-service.js";
import { bytesToId, idToBytes, type EntityId } from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";
import type { ScriptSummary } from "../executions/script-execution-adapter.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";
import { ResourceNotFoundError } from "../workspaces/workspace-service.js";

const EXCHANGE_LIMIT = 200;
const BODY_PREVIEW_LIMIT_BYTES = 256 * 1024;

export type RequestExchangeKind = "execution" | "capture";

/** Compact immutable metadata used to select one request-response exchange. */
export interface RequestExchangeSummary {
  readonly exchangeId: EntityId;
  readonly requestId: EntityId;
  readonly requestRevisionId: EntityId | null;
  readonly kind: RequestExchangeKind;
  readonly source: string;
  readonly label?: string;
  readonly state: "created" | "running" | "completed" | "failed";
  readonly status?: number;
  readonly bodyAvailability: "complete" | "truncated" | "unavailable";
  readonly occurredAt: string;
}

/** One selected exchange projected into the existing response presentation model. */
export interface RequestExchangeView {
  readonly summary: RequestExchangeSummary;
  readonly execution: ExecutionView;
}

/**
 * Presents persisted APInteract executions and imported captures as one
 * request-owned, immutable history without coupling their storage tables.
 */
export class RequestExchangeService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #workspaces: WorkspaceService;
  readonly #blobs: LocalBlobStore;

  constructor(
    database: Kysely<DatabaseSchema>,
    workspaces: WorkspaceService,
    blobs: LocalBlobStore,
  ) {
    this.#database = database;
    this.#workspaces = workspaces;
    this.#blobs = blobs;
  }

  /** Lists newest request exchanges from both persistent record sources. */
  async list(
    userId: EntityId,
    requestId: EntityId,
  ): Promise<readonly RequestExchangeSummary[]> {
    await this.#requireRequestAccess(userId, requestId);
    const [executionRows, captureRows] = await Promise.all([
      this.#database
        .selectFrom("executions")
        .select([
          "id",
          "request_revision_id",
          "state",
          "response_status",
          "body_complete",
          "body_bytes",
          "created_at",
        ])
        .where("request_id", "=", idToBytes(requestId))
        .orderBy("created_at", "desc")
        .limit(EXCHANGE_LIMIT)
        .execute(),
      this.#database
        .selectFrom("captured_exchanges")
        .select([
          "id",
          "request_revision_id",
          "status",
          "body_text",
          "body_complete",
          "body_bytes",
          "source_provider_id",
          "label",
          "recorded_at",
          "imported_at",
        ])
        .where("request_id", "=", idToBytes(requestId))
        .orderBy("imported_at", "desc")
        .limit(EXCHANGE_LIMIT)
        .execute(),
    ]);
    return [
      ...executionRows.map(
        (row): RequestExchangeSummary => ({
          exchangeId: bytesToId(row.id),
          requestId,
          requestRevisionId:
            row.request_revision_id === null
              ? null
              : bytesToId(row.request_revision_id),
          kind: "execution",
          source: "apinteract",
          state: row.state,
          ...(row.response_status === null
            ? {}
            : { status: row.response_status }),
          bodyAvailability: executionBodyAvailability(
            row.body_complete,
            row.body_bytes,
          ),
          occurredAt: new Date(row.created_at).toISOString(),
        }),
      ),
      ...captureRows.map(
        (row): RequestExchangeSummary => ({
          exchangeId: bytesToId(row.id),
          requestId,
          requestRevisionId: bytesToId(row.request_revision_id),
          kind: "capture",
          source: row.source_provider_id,
          ...(row.label === null ? {} : { label: row.label }),
          state: "completed",
          status: row.status,
          bodyAvailability: captureBodyAvailability(
            row.body_complete,
            row.body_text,
            row.body_bytes,
          ),
          occurredAt: new Date(
            row.recorded_at ?? row.imported_at,
          ).toISOString(),
        }),
      ),
    ]
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, EXCHANGE_LIMIT);
  }

  /** Loads one authorized exchange and its bounded response representation. */
  async get(
    userId: EntityId,
    requestId: EntityId,
    exchangeId: EntityId,
    kind: RequestExchangeKind,
  ): Promise<RequestExchangeView> {
    await this.#requireRequestAccess(userId, requestId);
    return kind === "capture"
      ? this.#capture(requestId, exchangeId)
      : this.#execution(requestId, exchangeId);
  }

  /** Verifies request ownership through its live workspace membership. */
  async #requireRequestAccess(
    userId: EntityId,
    requestId: EntityId,
  ): Promise<void> {
    const row = await this.#database
      .selectFrom("workspace_tree_nodes")
      .select("workspace_id")
      .where("id", "=", idToBytes(requestId))
      .where("kind", "=", "request")
      .executeTakeFirst();
    if (row === undefined) throw new ResourceNotFoundError("Request not found");
    await this.#workspaces.requireCanRead(
      this.#database,
      userId,
      bytesToId(row.workspace_id),
    );
  }

  /** Maps one imported capture without pretending that APInteract executed it. */
  async #capture(
    requestId: EntityId,
    exchangeId: EntityId,
  ): Promise<RequestExchangeView> {
    const row = await this.#database
      .selectFrom("captured_exchanges")
      .selectAll()
      .where("id", "=", idToBytes(exchangeId))
      .where("request_id", "=", idToBytes(requestId))
      .executeTakeFirst();
    if (row === undefined) {
      throw new ResourceNotFoundError("Request exchange not found");
    }
    const occurredAt = new Date(
      row.recorded_at ?? row.imported_at,
    ).toISOString();
    const summary: RequestExchangeSummary = {
      exchangeId,
      requestId,
      requestRevisionId: bytesToId(row.request_revision_id),
      kind: "capture",
      source: row.source_provider_id,
      ...(row.label === null ? {} : { label: row.label }),
      state: "completed",
      status: row.status,
      bodyAvailability: captureBodyAvailability(
        row.body_complete,
        row.body_text,
        row.body_bytes,
      ),
      occurredAt,
    };
    return {
      summary,
      execution: {
        executionId: exchangeId,
        requestId,
        state: "completed",
        status: row.status,
        headers: parseHeaders(row.headers_json),
        bodyComplete: row.body_complete === 1,
        bodyBytes: row.body_bytes,
        ...(row.body_text !== "" || row.body_bytes === 0
          ? { bodyPreview: row.body_text }
          : {}),
        createdAt: occurredAt,
        completedAt: new Date(row.imported_at).toISOString(),
        scriptLogs: [],
        scriptTests: [],
      },
    };
  }

  /** Reconstructs one persisted APInteract execution for historical display. */
  async #execution(
    requestId: EntityId,
    exchangeId: EntityId,
  ): Promise<RequestExchangeView> {
    const row = await this.#database
      .selectFrom("executions as execution")
      .leftJoin("blobs as blob", "blob.id", "execution.response_blob_id")
      .select([
        "execution.id",
        "execution.request_revision_id",
        "execution.state",
        "execution.response_status",
        "execution.response_headers_json",
        "execution.response_blob_id",
        "execution.body_complete",
        "execution.body_bytes",
        "execution.body_sha256",
        "execution.error_json",
        "execution.script_result_json",
        "execution.created_at",
        "execution.completed_at",
        "blob.storage_key",
        "blob.byte_length",
      ])
      .where("execution.id", "=", idToBytes(exchangeId))
      .where("execution.request_id", "=", idToBytes(requestId))
      .executeTakeFirst();
    if (row === undefined) {
      throw new ResourceNotFoundError("Request exchange not found");
    }
    const headers = parseHeaders(row.response_headers_json);
    const preview = await this.#executionPreview(
      row.storage_key,
      row.byte_length,
    );
    const scripts = parseScriptSummary(row.script_result_json);
    const occurredAt = new Date(row.created_at).toISOString();
    const summary: RequestExchangeSummary = {
      exchangeId,
      requestId,
      requestRevisionId:
        row.request_revision_id === null
          ? null
          : bytesToId(row.request_revision_id),
      kind: "execution",
      source: "apinteract",
      state: row.state,
      ...(row.response_status === null ? {} : { status: row.response_status }),
      bodyAvailability: executionBodyAvailability(
        row.body_complete,
        row.body_bytes,
      ),
      occurredAt,
    };
    return {
      summary,
      execution: {
        executionId: exchangeId,
        requestId,
        state: row.state,
        ...(row.response_status === null
          ? {}
          : { status: row.response_status, headers }),
        bodyComplete: row.body_complete === 1,
        ...(row.body_bytes === null ? {} : { bodyBytes: row.body_bytes }),
        ...(row.body_sha256 === null ? {} : { bodySha256: row.body_sha256 }),
        ...(row.response_blob_id === null
          ? {}
          : { bodyBlobId: bytesToId(row.response_blob_id) }),
        ...(preview === undefined ? {} : { bodyPreview: preview }),
        createdAt: occurredAt,
        ...(row.completed_at === null
          ? {}
          : { completedAt: new Date(row.completed_at).toISOString() }),
        ...parseExecutionError(row.error_json),
        scriptLogs: scripts.logs,
        scriptTests: scripts.tests,
        ...(scripts.error === undefined ? {} : { scriptError: scripts.error }),
      },
    };
  }

  /** Reads a complete bounded textual execution body for historical preview. */
  async #executionPreview(
    storageKey: string | null,
    byteLength: number | null,
  ): Promise<string | undefined> {
    if (storageKey === null || byteLength === null) return undefined;
    try {
      const bytes = await this.#blobs.readWithinLimit(
        storageKey,
        byteLength,
        BODY_PREVIEW_LIMIT_BYTES,
      );
      return bytes === undefined ? undefined : safeUtf8Preview(bytes);
    } catch {
      return undefined;
    }
  }
}

/** Classifies imported body evidence without confusing absence with emptiness. */
function captureBodyAvailability(
  complete: 0 | 1,
  body: string,
  bytes: number,
): RequestExchangeSummary["bodyAvailability"] {
  if (complete === 1) return "complete";
  return body !== "" || bytes === 0 ? "truncated" : "unavailable";
}

/** Classifies execution response bytes for compact history metadata. */
function executionBodyAvailability(
  complete: 0 | 1,
  bytes: number | null,
): RequestExchangeSummary["bodyAvailability"] {
  if (complete === 1) return "complete";
  return (bytes ?? 0) > 0 ? "truncated" : "unavailable";
}

/** Parses trusted persisted response headers defensively against damaged rows. */
function parseHeaders(
  value: string | null,
): readonly { readonly name: string; readonly value: string }[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): { name: string; value: string }[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const candidate = entry as Record<string, unknown>;
      return typeof candidate.name === "string" &&
        typeof candidate.value === "string"
        ? [{ name: candidate.name, value: candidate.value }]
        : [];
    });
  } catch {
    return [];
  }
}

/** Parses persisted script output while falling back to an empty safe result. */
function parseScriptSummary(value: string | null): ScriptSummary {
  if (value === null) return { logs: [], tests: [] };
  try {
    const parsed = JSON.parse(value) as ScriptSummary;
    return Array.isArray(parsed.logs) && Array.isArray(parsed.tests)
      ? parsed
      : { logs: [], tests: [] };
  } catch {
    return { logs: [], tests: [] };
  }
}

/** Parses the small persisted execution failure envelope for response display. */
function parseExecutionError(
  value: string | null,
): Pick<ExecutionView, "error"> {
  if (value === null) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "code" in parsed &&
      "message" in parsed &&
      typeof parsed.code === "string" &&
      typeof parsed.message === "string"
    ) {
      return {
        error: { code: parsed.code, message: parsed.message, errors: [] },
      };
    }
  } catch {
    // Damaged optional failure metadata must not hide the retained response.
  }
  return {};
}
