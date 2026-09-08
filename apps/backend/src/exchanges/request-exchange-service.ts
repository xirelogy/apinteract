import type { Kysely } from "kysely";

import type { components as BackendComponents } from "@apinteract/api-contracts/backend";

import type { LocalBlobStore } from "../blobs/local-blob-store.js";
import {
  safeUtf8Preview,
  type ExecutionView,
} from "../executions/execution-service.js";
import { bytesToId, idToBytes, type EntityId } from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";
import type {
  ScriptSummary,
  ScriptVariableWriteResult,
} from "../executions/script-execution-adapter.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";
import { ResourceNotFoundError } from "../workspaces/workspace-service.js";
import type { RedirectResult } from "../executions/redirect-request.js";
import {
  DEFAULT_REDIRECT_POLICY,
  validateResolvedRedirectPolicy,
} from "../executions/redirect-policy.js";

const EXCHANGE_LIMIT = 200;
const BODY_PREVIEW_LIMIT_BYTES = 256 * 1024;
type ExecutionTransportMetadata =
  BackendComponents["schemas"]["ExecutionTransportMetadata"];
type ExecutionTransportTimings =
  BackendComponents["schemas"]["ExecutionTransportTimings"];

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
        .where("root_execution_id", "is", null)
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
    const redirectRows =
      executionRows.length === 0
        ? []
        : await this.#database
            .selectFrom("executions")
            .select([
              "root_execution_id",
              "exchange_sequence",
              "state",
              "response_status",
              "body_complete",
              "body_bytes",
            ])
            .where(
              "root_execution_id",
              "in",
              executionRows.map((row) => row.id),
            )
            .orderBy("exchange_sequence")
            .execute();
    const terminalByRoot = new Map(
      redirectRows.flatMap((row) =>
        row.root_execution_id === null
          ? []
          : [
              [
                Buffer.from(row.root_execution_id).toString("hex"),
                row,
              ] as const,
            ],
      ),
    );
    return [
      ...executionRows.map((row): RequestExchangeSummary => {
        const terminal =
          terminalByRoot.get(Buffer.from(row.id).toString("hex")) ?? row;
        return {
          exchangeId: bytesToId(row.id),
          requestId,
          requestRevisionId:
            row.request_revision_id === null
              ? null
              : bytesToId(row.request_revision_id),
          kind: "execution",
          source: "apinteract",
          state: terminal.state,
          ...(terminal.response_status === null
            ? {}
            : { status: terminal.response_status }),
          bodyAvailability: executionBodyAvailability(
            terminal.body_complete,
            terminal.body_bytes,
          ),
          occurredAt: new Date(row.created_at).toISOString(),
        };
      }),
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

  /** Loads one execution exchange after authorizing its owning workspace. */
  async getExecution(
    userId: EntityId,
    executionId: EntityId,
  ): Promise<ExecutionView> {
    const row = await this.#database
      .selectFrom("executions")
      .select("workspace_id")
      .where("id", "=", idToBytes(executionId))
      .executeTakeFirst();
    if (row === undefined) {
      throw new ResourceNotFoundError("Execution exchange not found");
    }
    await this.#workspaces.requireCanRead(
      this.#database,
      userId,
      bytesToId(row.workspace_id),
    );
    return (await this.#execution(null, executionId, true)).execution;
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
        transportMetadataCollected: false,
        transportMetadataUnavailableReason: "disabled",
        scriptLogs: [],
        scriptTests: [],
      },
    };
  }

  /** Reconstructs one persisted APInteract execution for historical display. */
  async #execution(
    requestId: EntityId | null,
    exchangeId: EntityId,
    exact = false,
  ): Promise<RequestExchangeView> {
    const detailId = exact
      ? exchangeId
      : await this.#terminalExchangeId(exchangeId);
    let query = this.#database
      .selectFrom("executions as execution")
      .leftJoin("blobs as blob", "blob.id", "execution.response_blob_id")
      .select([
        "execution.id",
        "execution.request_id",
        "execution.root_execution_id",
        "execution.exchange_sequence",
        "execution.snapshot_json",
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
        "execution.transport_metadata_collected",
        "execution.transport_metadata_unavailable_reason",
        "execution.transport_metadata_json",
        "execution.transport_timings_json",
        "execution.redirect_json",
        "execution.outgoing_request_json",
        "execution.created_at",
        "execution.completed_at",
        "blob.storage_key",
        "blob.byte_length",
      ])
      .where("execution.id", "=", idToBytes(detailId));
    if (requestId !== null) {
      query = query.where("execution.request_id", "=", idToBytes(requestId));
    }
    const row = await query.executeTakeFirst();
    if (row === undefined) {
      throw new ResourceNotFoundError("Request exchange not found");
    }
    const headers = parseHeaders(row.response_headers_json);
    const preview = await this.#executionPreview(
      row.storage_key,
      row.byte_length,
    );
    const scripts = parseScriptSummary(row.script_result_json);
    const outgoingRequest = parseOutgoingRequest(row.outgoing_request_json);
    const redirect = parseRedirectResult(row.redirect_json);
    const occurredAt = new Date(row.created_at).toISOString();
    const summary: RequestExchangeSummary = {
      exchangeId,
      requestId:
        requestId ??
        (row.request_id === null ? detailId : bytesToId(row.request_id)),
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
        executionId: detailId,
        ...(row.request_id === null
          ? {}
          : { requestId: bytesToId(row.request_id) }),
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
        ...parseTransportResult(
          row.transport_metadata_collected,
          row.transport_metadata_unavailable_reason,
          row.transport_metadata_json,
          row.transport_timings_json,
        ),
        ...parseExecutionError(row.error_json),
        scriptLogs: scripts.logs,
        scriptTests: scripts.tests,
        ...(scripts.variableWrites === undefined
          ? {}
          : { scriptVariableWrites: scripts.variableWrites }),
        ...(scripts.error === undefined ? {} : { scriptError: scripts.error }),
        ...(outgoingRequest === undefined ? {} : { outgoingRequest }),
        rootExecutionId:
          row.root_execution_id === null
            ? detailId
            : bytesToId(row.root_execution_id),
        exchangeSequence: row.exchange_sequence,
        effectiveRedirectPolicy: parseEffectiveRedirectPolicy(
          row.snapshot_json,
        ),
        ...(redirect === undefined ? {} : { redirect }),
        redirectChain: await this.#redirectChain(
          row.root_execution_id === null
            ? detailId
            : bytesToId(row.root_execution_id),
        ),
      },
    };
  }

  /** Resolves a root history entry to the terminal exchange selected by default. */
  async #terminalExchangeId(rootExecutionId: EntityId): Promise<EntityId> {
    const child = await this.#database
      .selectFrom("executions")
      .select("id")
      .where("root_execution_id", "=", idToBytes(rootExecutionId))
      .orderBy("exchange_sequence", "desc")
      .executeTakeFirst();
    return child === undefined ? rootExecutionId : bytesToId(child.id);
  }

  /** Builds compact secret-safe navigation for every exchange in a redirect chain. */
  async #redirectChain(rootExecutionId: EntityId) {
    const rows = await this.#database
      .selectFrom("executions")
      .select([
        "id",
        "exchange_sequence",
        "state",
        "response_status",
        "outgoing_request_json",
      ])
      .where((expression) =>
        expression.or([
          expression("id", "=", idToBytes(rootExecutionId)),
          expression("root_execution_id", "=", idToBytes(rootExecutionId)),
        ]),
      )
      .orderBy("exchange_sequence")
      .execute();
    const finalSequence = rows.at(-1)?.exchange_sequence ?? 0;
    return rows.map((row) => {
      const outgoing = parseOutgoingRequest(row.outgoing_request_json);
      return {
        exchangeId: bytesToId(row.id),
        sequence: row.exchange_sequence,
        state: row.state,
        ...(row.response_status === null
          ? {}
          : { status: row.response_status }),
        method: outgoing?.method ?? "GET",
        url: outgoing?.url ?? { value: "[unavailable]", redacted: true },
        final: row.exchange_sequence === finalSequence,
      };
    });
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

/** Parses a persisted secret-safe outgoing request for historical inspection. */
function parseOutgoingRequest(
  value: string | null,
): ExecutionView["outgoingRequest"] {
  const parsed = parseJsonRecord(value);
  if (
    parsed === undefined ||
    typeof parsed.method !== "string" ||
    !Array.isArray(parsed.headers) ||
    typeof parsed.url !== "object" ||
    parsed.url === null ||
    typeof parsed.body !== "object" ||
    parsed.body === null
  ) {
    return undefined;
  }
  return parsed as unknown as NonNullable<ExecutionView["outgoingRequest"]>;
}

/** Restores the immutable resolved redirect policy from an execution snapshot. */
function parseEffectiveRedirectPolicy(
  snapshotJson: string,
): NonNullable<ExecutionView["effectiveRedirectPolicy"]> {
  try {
    const snapshot = JSON.parse(snapshotJson) as { redirectPolicy?: unknown };
    return validateResolvedRedirectPolicy(
      snapshot.redirectPolicy as typeof DEFAULT_REDIRECT_POLICY,
    );
  } catch {
    return DEFAULT_REDIRECT_POLICY;
  }
}

/** Parses one source redirect relationship without trusting damaged history. */
function parseRedirectResult(value: string | null): RedirectResult | undefined {
  const parsed = parseJsonRecord(value);
  if (
    parsed === undefined ||
    typeof parsed.location !== "string" ||
    !["followed", "not_followed", "failed"].includes(String(parsed.outcome)) ||
    !Array.isArray(parsed.removedHeaderNames)
  ) {
    return undefined;
  }
  return parsed as unknown as RedirectResult;
}

/** Parses persisted script output while falling back to an empty safe result. */
function parseScriptSummary(value: string | null): ScriptSummary {
  if (value === null) return { logs: [], tests: [] };
  try {
    const parsed = JSON.parse(value) as ScriptSummary;
    if (!Array.isArray(parsed.logs) || !Array.isArray(parsed.tests)) {
      return { logs: [], tests: [] };
    }
    const variableWrites = Array.isArray(parsed.variableWrites)
      ? parsed.variableWrites.filter(isScriptVariableWriteResult)
      : [];
    return {
      logs: parsed.logs,
      tests: parsed.tests,
      ...(variableWrites.length === 0 ? {} : { variableWrites }),
      ...(parsed.error === undefined ? {} : { error: parsed.error }),
    };
  } catch {
    return { logs: [], tests: [] };
  }
}

/** Validates the value-free variable receipt stored with an execution. */
function isScriptVariableWriteResult(
  value: unknown,
): value is ScriptVariableWriteResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    [
      "request",
      "parent-collection",
      "workspace",
      "selected-environment",
    ].includes(String(candidate.scope)) &&
    (candidate.kind === "value" || candidate.kind === "secret")
  );
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

/** Reconstructs optional transport evidence without trusting damaged JSON rows. */
function parseTransportResult(
  collected: 0 | 1,
  unavailableReason: "disabled" | "unsupported" | null,
  metadataJson: string | null,
  timingsJson: string | null,
): Pick<
  ExecutionView,
  | "timings"
  | "transportMetadataCollected"
  | "transportMetadataUnavailableReason"
  | "transportMetadata"
> {
  const timings = parseTransportTimings(timingsJson);
  const metadata = parseTransportMetadata(metadataJson);
  return {
    transportMetadataCollected: collected === 1,
    ...(unavailableReason === null
      ? {}
      : { transportMetadataUnavailableReason: unavailableReason }),
    ...(timings === undefined ? {} : { timings }),
    ...(metadata === undefined ? {} : { transportMetadata: metadata }),
  };
}

/** Parses non-negative persisted phase durations and requires total duration. */
function parseTransportTimings(
  value: string | null,
): ExecutionTransportTimings | undefined {
  const parsed = parseJsonRecord(value);
  if (parsed === undefined || !isNonNegativeNumber(parsed.totalMs)) {
    return undefined;
  }
  const optionalNames = ["dnsMs", "connectMs", "tlsMs", "firstByteMs"] as const;
  if (
    optionalNames.some(
      (name) =>
        parsed[name] !== undefined && !isNonNegativeNumber(parsed[name]),
    )
  ) {
    return undefined;
  }
  return parsed as ExecutionTransportTimings;
}

/** Parses the compact transport observation written by terminal persistence. */
function parseTransportMetadata(
  value: string | null,
): ExecutionTransportMetadata | undefined {
  const parsed = parseJsonRecord(value);
  if (parsed === undefined) return undefined;
  if (
    parsed.connectionReused !== undefined &&
    typeof parsed.connectionReused !== "boolean"
  ) {
    return undefined;
  }
  if (
    (parsed.localEndpoint !== undefined &&
      !isNetworkEndpoint(parsed.localEndpoint)) ||
    (parsed.remoteEndpoint !== undefined &&
      !isNetworkEndpoint(parsed.remoteEndpoint)) ||
    (parsed.tls !== undefined && !isTlsMetadata(parsed.tls))
  ) {
    return undefined;
  }
  return parsed as ExecutionTransportMetadata;
}

/** Parses one JSON object while treating malformed optional evidence as absent. */
function parseJsonRecord(
  value: string | null,
): Record<string, unknown> | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Validates the stable address family and port portion of an endpoint. */
function isNetworkEndpoint(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.address === "string" &&
    Number.isInteger(candidate.port) &&
    Number(candidate.port) >= 1 &&
    Number(candidate.port) <= 65_535 &&
    (candidate.family === "ipv4" || candidate.family === "ipv6")
  );
}

/** Validates the required TLS mode and compact certificate summaries. */
function isTlsMetadata(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.verificationMode !== "strict" &&
    candidate.verificationMode !== "insecure"
  ) {
    return false;
  }
  if (
    candidate.peerCertificateChain !== undefined &&
    (!Array.isArray(candidate.peerCertificateChain) ||
      candidate.peerCertificateChain.length > 16 ||
      !candidate.peerCertificateChain.every(isCertificateSummary))
  ) {
    return false;
  }
  return true;
}

/** Validates the immutable identity and order of a certificate summary. */
function isCertificateSummary(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sha256Fingerprint === "string" &&
    /^[0-9a-f]{64}$/u.test(candidate.sha256Fingerprint) &&
    Number.isInteger(candidate.chainPosition) &&
    Number(candidate.chainPosition) >= 0
  );
}

/** Reports whether a persisted timing is finite and non-negative. */
function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
