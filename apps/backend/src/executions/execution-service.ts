import { createHash, X509Certificate } from "node:crypto";
import type { Kysely, Transaction } from "kysely";

import type { components as BackendComponents } from "@apinteract/api-contracts/backend";
import type { components as ProxyComponents } from "@apinteract/api-contracts/proxy";

import type { AuditService } from "../audit/audit-service.js";
import {
  type LocalBlobStore,
  type LocalBlobWriter,
  type StoredBlob,
} from "../blobs/local-blob-store.js";
import { bytesToId, idToBytes, type EntityId } from "../foundation/id.js";
import { VariableResolver } from "../environments/variable-resolver.js";
import type { DatabaseSchema } from "../persistence/schema.js";
import type { ProxyClient } from "../proxy/proxy-client.js";
import { ProxyExecutionError } from "../proxy/proxy-client.js";
import type {
  RequestExecutionInput,
  RequestService,
  PreparedExecution,
} from "../requests/request-service.js";
import { composeWithVariables } from "../requests/request-service.js";
import { ScriptService } from "../scripting/script-service.js";
import {
  DEFAULT_SCRIPT_VARIABLE_WRITE_POLICY,
  ScriptExecutionError,
  type ScriptRequest,
  type ScriptTestResult,
  type ScriptVariableWrite,
  type ScriptVariableWritePolicy,
} from "../scripting/script-types.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";
import { ResourceNotFoundError } from "../workspaces/workspace-service.js";
import type {
  TemporaryRequestVariableProfile,
  VariableService,
} from "../variables/variable-service.js";
import { DEFAULT_BACKEND_USER_AGENT } from "../version.js";
import {
  executionRequestFromScript,
  postResponseScriptView,
  preRequestScriptView,
  scriptExecutionContext,
  scriptPhaseError,
  scriptVariables,
  type PhasedScriptLog,
  type ScriptPhaseError,
  type ScriptSummary,
  type ScriptVariableWriteResult,
} from "./script-execution-adapter.js";

type ResponseHead = ProxyComponents["schemas"]["ResponseHead"];
type ResponseComplete = ProxyComponents["schemas"]["ResponseComplete"];
type ProxyTransportObservation =
  ProxyComponents["schemas"]["TransportObservation"];
type ExecutionTransportMetadata =
  BackendComponents["schemas"]["ExecutionTransportMetadata"];
type ExecutionTransportTimings =
  BackendComponents["schemas"]["ExecutionTransportTimings"];
/** Maximum characters retained in the WebSocket-safe outgoing body preview. */
const OUTGOING_BODY_PREVIEW_CHARACTERS = 262_144;
/** Maximum raw DER retained for one execution certificate chain. */
const MAX_TRANSPORT_CERTIFICATE_BYTES = 256 * 1_024;
/** Maximum certificates retained from one execution TLS peer chain. */
const MAX_TRANSPORT_CERTIFICATES = 16;

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
  readonly requestId?: EntityId;
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
  readonly timings?: ExecutionTransportTimings;
  readonly transportMetadataCollected: boolean;
  readonly transportMetadataUnavailableReason?: "disabled" | "unsupported";
  readonly transportMetadata?: ExecutionTransportMetadata;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly errors: readonly [];
  };
  readonly outgoingRequest?: OutgoingRequestView;
  readonly scriptLogs: readonly PhasedScriptLog[];
  readonly scriptTests: readonly ScriptTestResult[];
  readonly scriptVariableWrites?: readonly ScriptVariableWriteResult[];
  readonly scriptError?: ScriptPhaseError;
}

/** Secret-safe representation of the materialized request handed to the proxy. */
export interface OutgoingRequestView {
  readonly method: string;
  readonly url: {
    readonly value: string;
    readonly redacted: boolean;
  };
  readonly headers: readonly {
    readonly name: string;
    readonly value: string;
    readonly redacted: boolean;
    readonly derived: boolean;
  }[];
  readonly body: {
    readonly value: string;
    readonly encoding: "utf8" | "base64";
    readonly byteLength: number;
    readonly redacted: boolean;
    readonly truncated: boolean;
  };
}

export interface ExecutionBody {
  readonly storageKey: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/** Canonical DER bytes for one certificate referenced by an authorized execution. */
export interface ExecutionTransportCertificate {
  readonly der: Buffer;
  readonly sha256Fingerprint: string;
}

interface ExecutionTransportResult {
  readonly collected: boolean;
  readonly unavailableReason?: "disabled" | "unsupported";
  readonly timings?: ExecutionTransportTimings;
  readonly observation?: ProxyTransportObservation;
}

/** Optional persistence capability used by post-response automation. */
export interface ExecutionVariableWriteOptions {
  readonly variables?: VariableService;
  readonly policy?: ScriptVariableWritePolicy;
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
  readonly #scripts: ScriptService;
  readonly #variables: VariableService | undefined;
  readonly #variableWritePolicy: ScriptVariableWritePolicy;
  readonly #starting = new Set<Promise<ExecutionView>>();
  readonly #active = new Set<Promise<void>>();
  #accepting = true;

  constructor(
    database: Kysely<DatabaseSchema>,
    requests: RequestService,
    workspaces: WorkspaceService,
    proxy: ProxyClient,
    blobs: LocalBlobStore,
    audit: AuditService,
    scripts = new ScriptService(),
    variableWrites: ExecutionVariableWriteOptions = {},
  ) {
    this.#database = database;
    this.#requests = requests;
    this.#workspaces = workspaces;
    this.#proxy = proxy;
    this.#blobs = blobs;
    this.#audit = audit;
    this.#scripts = scripts;
    this.#variables = variableWrites.variables;
    this.#variableWritePolicy =
      variableWrites.policy ?? DEFAULT_SCRIPT_VARIABLE_WRITE_POLICY;
  }

  /** Starts asynchronous proxy execution and returns its initial running view. */
  async start(
    userId: EntityId,
    sessionId: EntityId,
    requestId: EntityId,
    publish: (event: ExecutionEvent) => void,
  ): Promise<ExecutionView> {
    return this.#beginStart(async () => {
      const prepared = await this.#requests.prepareExecution(
        userId,
        sessionId,
        requestId,
      );
      return this.#startPrepared(prepared, userId, publish);
    });
  }

  /** Starts asynchronous execution from one immutable request revision. */
  async startRevision(
    userId: EntityId,
    sessionId: EntityId,
    requestId: EntityId,
    revisionId: EntityId,
    publish: (event: ExecutionEvent) => void,
  ): Promise<ExecutionView> {
    return this.#beginStart(async () => {
      const prepared = await this.#requests.prepareRevisionExecution(
        userId,
        sessionId,
        requestId,
        revisionId,
      );
      return this.#startPrepared(prepared, userId, publish);
    });
  }

  /** Starts a workspace-owned execution without saving a reusable request. */
  async startTemporary(
    userId: EntityId,
    sessionId: EntityId,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
    request: RequestExecutionInput,
    publish: (event: ExecutionEvent) => void,
    temporaryVariables: TemporaryRequestVariableProfile | null = null,
  ): Promise<ExecutionView> {
    return this.#beginStart(async () => {
      const prepared = await this.#requests.prepareTemporaryExecution(
        userId,
        sessionId,
        workspaceId,
        parentCollectionId,
        request,
        temporaryVariables,
      );
      return this.#startPrepared(prepared, userId, publish);
    });
  }

  /** Registers preparation before yielding so shutdown can drain the full start. */
  async #beginStart(
    operation: () => Promise<ExecutionView>,
  ): Promise<ExecutionView> {
    if (!this.#accepting) {
      throw new Error("Request execution is unavailable during shutdown");
    }
    const starting = operation();
    this.#starting.add(starting);
    try {
      return await starting;
    } finally {
      this.#starting.delete(starting);
    }
  }

  /** Marks one prepared execution running and starts asynchronous proxy work. */
  async #startPrepared(
    prepared: PreparedExecution,
    userId: EntityId,
    publish: (event: ExecutionEvent) => void,
  ): Promise<ExecutionView> {
    await this.#database
      .updateTable("executions")
      .set({ state: "running" })
      .where("id", "=", idToBytes(prepared.executionId))
      .execute();
    // The caller receives the running view immediately. Terminal state arrives
    // through execution events after proxy streaming and persistence finish.
    const active = this.#run(prepared, userId, publish);
    this.#active.add(active);
    // Both outcomes remove lifecycle bookkeeping. Terminal persistence errors
    // are already represented by #run when storage remains available; a
    // second rejection must not become an unhandled process-level failure.
    void active.then(
      () => this.#active.delete(active),
      () => this.#active.delete(active),
    );
    return {
      executionId: prepared.executionId,
      ...(prepared.request.requestId === undefined
        ? {}
        : { requestId: prepared.request.requestId }),
      state: "running",
      bodyComplete: false,
      createdAt: new Date(prepared.createdAt).toISOString(),
      transportMetadataCollected: false,
      scriptLogs: [],
      scriptTests: [],
    };
  }

  /** Stops admitting executions and drains proxy work already in progress. */
  async close(): Promise<void> {
    this.#accepting = false;
    // A rejected validation or authorization start has no proxy work to drain
    // and must not prevent already accepted executions from reaching terminal
    // persistence before the database closes.
    await Promise.allSettled(this.#starting);
    await Promise.allSettled(this.#active);
  }

  /** Resolves authorized immutable response-body metadata for an execution. */
  async getBody(
    userId: EntityId,
    executionId: EntityId,
  ): Promise<ExecutionBody> {
    const row = await this.#database
      .selectFrom("executions as execution")
      .innerJoin("blobs as blob", "blob.id", "execution.response_blob_id")
      .select([
        "execution.workspace_id",
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

  /** Resolves exact certificate bytes through an execution-scoped authorization check. */
  async transportCertificate(
    userId: EntityId,
    executionId: EntityId,
    sha256Fingerprint: string,
  ): Promise<ExecutionTransportCertificate> {
    const row = await this.#database
      .selectFrom("executions as execution")
      .innerJoin(
        "execution_transport_certificates as reference",
        "reference.execution_id",
        "execution.id",
      )
      .innerJoin(
        "transport_certificates as certificate",
        "certificate.sha256_fingerprint",
        "reference.sha256_fingerprint",
      )
      .select([
        "execution.workspace_id",
        "certificate.der_bytes",
        "certificate.sha256_fingerprint",
      ])
      .where("execution.id", "=", idToBytes(executionId))
      .where("reference.sha256_fingerprint", "=", sha256Fingerprint)
      .executeTakeFirst();
    if (row === undefined) {
      throw new ResourceNotFoundError("Execution certificate not found");
    }
    await this.#workspaces.requireCanRead(
      this.#database,
      userId,
      bytesToId(row.workspace_id),
    );
    return {
      der: Buffer.from(row.der_bytes),
      sha256Fingerprint: row.sha256_fingerprint,
    };
  }

  /** Streams a prepared request through the proxy into terminal persistence. */
  async #run(
    prepared: PreparedExecution,
    userId: EntityId,
    publish: (event: ExecutionEvent) => void,
  ): Promise<void> {
    const writer = this.#blobs.createWriter();
    let head: ResponseHead | undefined;
    let working = prepared;
    let outgoingRequest: OutgoingRequestView | undefined;
    let local: Readonly<Record<string, string>> = {};
    let scripts: ScriptSummary = { logs: [], tests: [] };
    try {
      const resolver = new VariableResolver(prepared.variables);
      if (prepared.request.preRequestScript.trim() !== "") {
        try {
          const result = await this.#scripts.runPreRequest(
            prepared.request.preRequestScript,
            {
              execution: scriptExecutionContext(prepared),
              request: preRequestScriptView(
                prepared.request,
                resolver,
                prepared.templateRequest,
              ),
              variables: scriptVariables(prepared, resolver),
            },
          );
          local = result.local;
          scripts = {
            logs: result.logs.map((entry) => ({
              ...entry,
              phase: "pre-request" as const,
            })),
            tests: [],
          };
          const scriptedRequest = executionRequestFromScript(
            prepared.request,
            result.request,
          );
          working = {
            ...prepared,
            templateRequest: scriptedRequest,
            request: scriptedRequest,
            ...(prepared.materialized
              ? { postScriptRequest: result.request }
              : {}),
          };
        } catch (cause) {
          scripts = {
            ...scripts,
            error: scriptPhaseError(cause, "pre-request"),
          };
          throw cause;
        }
      }
      working = {
        ...working,
        templateRequest: withDefaultUserAgent(working.templateRequest),
        request: withDefaultUserAgent(working.request),
      };
      if (!working.materialized) {
        const templateRequest = working.request;
        const composed = composeWithVariables(templateRequest, resolver);
        working = {
          ...working,
          templateRequest,
          request: composed.request,
          postScriptRequest: postResponseScriptView(
            templateRequest,
            composed.request,
            resolver,
          ),
          materialized: true,
        };
        await this.#database
          .updateTable("executions")
          .set({
            snapshot_json: JSON.stringify({
              ...composed.persisted,
              targetMode: "absolute",
              queryMode: "structured",
              variableProfiles: prepared.variableEvidence,
              secretReferences: composed.secretReferences,
            }),
            script_result_json: JSON.stringify(scripts),
          })
          .where("id", "=", idToBytes(prepared.executionId))
          .execute();
      }
      outgoingRequest = outgoingRequestView(
        working.postScriptRequest ??
          postResponseScriptView(
            working.templateRequest,
            working.request,
            resolver,
          ),
        working.request,
      );
      // Sink callbacks are awaited by ProxyClient, so filesystem writes apply
      // backpressure to the proxy response stream.
      await this.#proxy.execute(
        working.executionId,
        working.request.method,
        materializeTargetUrl(working.request.targetUrl, working.request.query),
        working.request.headers
          .filter((header) => header.enabled)
          .map(({ name, value }) => ({ name, value })),
        working.request.bodyBytes === undefined
          ? Buffer.from(working.request.body, "utf8")
          : Buffer.from(working.request.bodyBytes),
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
              working,
              userId,
              writer,
              head,
              value,
              local,
              scripts,
              outgoingRequest,
              publish,
            );
          },
        },
        working.request.bodyPresent,
      );
    } catch (cause) {
      await this.#fail(
        working,
        userId,
        writer,
        head,
        cause,
        scripts,
        outgoingRequest,
        publish,
      );
    }
  }

  /** Validates and commits a complete proxy response and its blob metadata. */
  async #complete(
    prepared: PreparedExecution,
    userId: EntityId,
    writer: LocalBlobWriter,
    head: ResponseHead | undefined,
    complete: ResponseComplete,
    local: Readonly<Record<string, string>>,
    scripts: ScriptSummary,
    outgoingRequest: OutgoingRequestView | undefined,
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
    if (prepared.request.postResponseScript.trim() !== "") {
      let variableWrites: readonly ScriptVariableWrite[] = [];
      try {
        let body: Buffer | undefined;
        try {
          body = await this.#blobs.readWithinLimit(
            blob.storageKey,
            blob.byteLength,
            1_048_576,
          );
        } catch (cause) {
          throw scriptHostError(
            "response_body_unavailable",
            "The stored response body could not be read for the post-response script",
            cause,
          );
        }
        let requestForScript;
        try {
          requestForScript =
            prepared.postScriptRequest ??
            postResponseScriptView(
              prepared.request,
              prepared.request,
              new VariableResolver(prepared.variables),
            );
        } catch (cause) {
          throw scriptHostError(
            "runtime_error",
            "The backend could not prepare the request context for the post-response script",
            cause,
          );
        }
        const result = await this.#scripts.runPostResponse(
          prepared.request.postResponseScript,
          {
            execution: scriptExecutionContext(prepared),
            request: requestForScript,
            response: {
              status: head.status,
              headers: head.headers.map((header) => ({
                ...header,
                readable: true,
                sensitive: false,
              })),
              body: {
                size: blob.byteLength,
                sha256: blob.sha256,
                available: body !== undefined,
                ...(body === undefined
                  ? { unavailableReason: "too_large" as const }
                  : { bytes: body }),
              },
            },
            variables: scriptVariables(
              prepared,
              new VariableResolver(prepared.variables),
            ),
            local,
            variableWritePolicy: this.#effectiveVariableWritePolicy(prepared),
          },
        );
        variableWrites = result.variableWrites;
        const sequenceOffset = scripts.logs.reduce(
          (latest, entry) => Math.max(latest, entry.sequence),
          0,
        );
        scripts = {
          logs: [
            ...scripts.logs,
            ...result.logs.map((entry) => ({
              ...entry,
              sequence: entry.sequence + sequenceOffset,
              phase: "post-response" as const,
            })),
          ],
          tests: result.tests.map((test) => ({
            ...test,
            sequence: test.sequence + sequenceOffset,
          })),
        };
      } catch (cause) {
        scripts = {
          ...scripts,
          error: scriptPhaseError(cause, "post-response"),
        };
      }
      try {
        const view = await this.#persistTerminal(
          prepared,
          userId,
          blob,
          head,
          true,
          null,
          scripts,
          outgoingRequest,
          variableWrites,
          transportResultFromComplete(head, complete),
        );
        publish({
          type: "execution.completed",
          executionId: prepared.executionId,
          payload: view,
        });
        return;
      } catch (cause) {
        if (!(cause instanceof ScriptExecutionError)) throw cause;
        scripts = {
          ...scripts,
          error: scriptPhaseError(cause, "post-response"),
        };
      }
    }
    const view = await this.#persistTerminal(
      prepared,
      userId,
      blob,
      head,
      true,
      null,
      scripts,
      outgoingRequest,
      [],
      transportResultFromComplete(head, complete),
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
    scripts: ScriptSummary,
    outgoingRequest: OutgoingRequestView | undefined,
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
      scripts,
      outgoingRequest,
      [],
      transportResultFromFailure(head, cause),
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
    scripts: ScriptSummary,
    outgoingRequest: OutgoingRequestView | undefined,
    variableWrites: readonly ScriptVariableWrite[],
    transportResult: ExecutionTransportResult,
  ): Promise<ExecutionView> {
    const completedAt = Date.now();
    let executionTransportMetadata: ExecutionTransportMetadata | undefined;
    const committedVariableWrites = variableWrites.map(
      scriptVariableWriteResult,
    );
    const persistedScripts =
      committedVariableWrites.length === 0
        ? scripts
        : { ...scripts, variableWrites: committedVariableWrites };
    // The file is committed before this transaction. Blob metadata, its
    // execution reference, terminal state, and audit outbox entry are then
    // committed atomically. Crash recovery may need to remove an orphan file
    // that was renamed before this transaction began.
    await this.#database.transaction().execute(async (transaction) => {
      executionTransportMetadata = await this.#persistTransportMetadata(
        transaction,
        prepared.executionId,
        transportResult.observation,
        completedAt,
      );
      await this.#applyVariableWrites(
        transaction,
        prepared,
        userId,
        variableWrites,
      );
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
          script_result_json: JSON.stringify(persistedScripts),
          transport_metadata_collected: transportResult.collected ? 1 : 0,
          transport_metadata_unavailable_reason:
            transportResult.unavailableReason ?? null,
          transport_metadata_json:
            executionTransportMetadata === undefined
              ? null
              : JSON.stringify(executionTransportMetadata),
          transport_timings_json:
            transportResult.timings === undefined
              ? null
              : JSON.stringify(transportResult.timings),
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
          requestId: prepared.request.requestId ?? null,
          bodyComplete,
          bodyBytes: blob?.byteLength ?? 0,
          errorCode: error?.code,
        },
      });
    });

    const preview =
      blob === undefined || head === undefined
        ? undefined
        : safeUtf8Preview(blob.previewBytes);
    return {
      executionId: prepared.executionId,
      ...(prepared.request.requestId === undefined
        ? {}
        : { requestId: prepared.request.requestId }),
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
      ...(transportResult.timings === undefined
        ? {}
        : { timings: transportResult.timings }),
      transportMetadataCollected: transportResult.collected,
      ...(transportResult.unavailableReason === undefined
        ? {}
        : {
            transportMetadataUnavailableReason:
              transportResult.unavailableReason,
          }),
      ...(executionTransportMetadata === undefined
        ? {}
        : { transportMetadata: executionTransportMetadata }),
      ...(error === null ? {} : { error: { ...error, errors: [] as const } }),
      ...(outgoingRequest === undefined ? {} : { outgoingRequest }),
      scriptLogs: scripts.logs,
      scriptTests: scripts.tests,
      ...(committedVariableWrites.length === 0
        ? {}
        : { scriptVariableWrites: committedVariableWrites }),
      ...(scripts.error === undefined ? {} : { scriptError: scripts.error }),
    };
  }

  /** Stores canonical certificates and returns a compact execution observation. */
  async #persistTransportMetadata(
    transaction: Transaction<DatabaseSchema>,
    executionId: EntityId,
    observation: ProxyTransportObservation | undefined,
    observedAt: number,
  ): Promise<ExecutionTransportMetadata | undefined> {
    if (observation === undefined) return undefined;
    const { tls: proxyTls, ...observationWithoutTls } = observation;
    if (proxyTls === undefined) {
      return observationWithoutTls;
    }
    const certificateSummaries: BackendComponents["schemas"]["ExecutionCertificateSummary"][] =
      [];
    const peerCertificateChain = proxyTls.peerCertificateChain ?? [];
    if (peerCertificateChain.length > MAX_TRANSPORT_CERTIFICATES) {
      throw new Error("Proxy certificate chain exceeds the certificate limit");
    }
    let retainedCertificateBytes = 0;
    const retainedFingerprints = new Set<string>();
    for (const [chainPosition, certificate] of peerCertificateChain.entries()) {
      const der = decodeCanonicalBase64(certificate.derBase64);
      retainedCertificateBytes += der.byteLength;
      if (retainedCertificateBytes > MAX_TRANSPORT_CERTIFICATE_BYTES) {
        throw new Error("Proxy certificate chain exceeds the DER byte limit");
      }
      const fingerprint = createHash("sha256").update(der).digest("hex");
      if (fingerprint !== certificate.sha256Fingerprint) {
        throw new Error(
          "Proxy certificate fingerprint does not match DER bytes",
        );
      }
      if (retainedFingerprints.has(fingerprint)) {
        throw new Error(
          "Proxy certificate chain contains a duplicate certificate",
        );
      }
      retainedFingerprints.add(fingerprint);
      const summary = certificateSummary(der, fingerprint, chainPosition);
      await transaction
        .insertInto("transport_certificates")
        .values({
          sha256_fingerprint: fingerprint,
          der_bytes: der,
          subject: summary.subject ?? null,
          issuer: summary.issuer ?? null,
          valid_from:
            summary.validFrom === undefined
              ? null
              : Date.parse(summary.validFrom),
          valid_to:
            summary.validTo === undefined ? null : Date.parse(summary.validTo),
          serial_number: summary.serialNumber ?? null,
          subject_alternative_names_json:
            summary.subjectAlternativeNames === undefined
              ? null
              : JSON.stringify(summary.subjectAlternativeNames),
          created_at: observedAt,
        })
        .onConflict((conflict) =>
          conflict.column("sha256_fingerprint").doNothing(),
        )
        .execute();
      const stored = await transaction
        .selectFrom("transport_certificates")
        .select("der_bytes")
        .where("sha256_fingerprint", "=", fingerprint)
        .executeTakeFirstOrThrow();
      if (!Buffer.from(stored.der_bytes).equals(der)) {
        throw new Error("Certificate fingerprint collision detected");
      }
      await transaction
        .insertInto("execution_transport_certificates")
        .values({
          execution_id: idToBytes(executionId),
          sha256_fingerprint: fingerprint,
          chain_position: chainPosition,
        })
        .execute();
      certificateSummaries.push(summary);
    }
    return {
      ...observationWithoutTls,
      tls: executionTlsMetadata(proxyTls, certificateSummaries),
    };
  }

  /** Restricts configured writes to destinations pinned for this execution. */
  #effectiveVariableWritePolicy(
    prepared: PreparedExecution,
  ): ScriptVariableWritePolicy {
    if (this.#variables === undefined) {
      return { allowedScopes: [], allowSecrets: false };
    }
    const available = new Set([
      "workspace",
      ...(prepared.variableWriteTargets.parentCollection === undefined
        ? []
        : ["parent-collection"]),
      ...(prepared.variableWriteTargets.request === undefined
        ? []
        : ["request"]),
      ...(prepared.variableWriteTargets.selectedEnvironment === undefined
        ? []
        : ["selected-environment"]),
    ]);
    return {
      allowedScopes: this.#variableWritePolicy.allowedScopes.filter((scope) =>
        available.has(scope),
      ),
      allowSecrets: this.#variableWritePolicy.allowSecrets,
    };
  }

  /** Rechecks and applies worker-requested writes inside terminal persistence. */
  async #applyVariableWrites(
    transaction: Transaction<DatabaseSchema>,
    prepared: PreparedExecution,
    userId: EntityId,
    writes: readonly ScriptVariableWrite[],
  ): Promise<void> {
    if (writes.length === 0) return;
    if (this.#variables === undefined) {
      throw new ScriptExecutionError(
        "variable_write_denied",
        "Persistent variable writes are unavailable",
      );
    }
    await this.#variables.applyScriptWritesInTransaction(
      transaction,
      userId,
      prepared.executionId,
      prepared.variableWriteTargets,
      writes,
      this.#variableWritePolicy,
    );
  }
}

/** Replaces raw peer DER with compact summaries for execution JSON storage. */
function executionTlsMetadata(
  value: NonNullable<ProxyTransportObservation["tls"]>,
  peerCertificateChain: BackendComponents["schemas"]["ExecutionCertificateSummary"][],
): BackendComponents["schemas"]["ExecutionTlsMetadata"] {
  return {
    verificationMode: value.verificationMode,
    ...(value.authorized === undefined ? {} : { authorized: value.authorized }),
    ...(value.authorizationErrorCode === undefined
      ? {}
      : { authorizationErrorCode: value.authorizationErrorCode }),
    ...(value.protocol === undefined ? {} : { protocol: value.protocol }),
    ...(value.alpnProtocol === undefined
      ? {}
      : { alpnProtocol: value.alpnProtocol }),
    ...(value.serverName === undefined ? {} : { serverName: value.serverName }),
    ...(value.cipher === undefined ? {} : { cipher: value.cipher }),
    ...(peerCertificateChain.length === 0 ? {} : { peerCertificateChain }),
    ...(value.peerCertificateChainCaptureComplete === undefined
      ? {}
      : {
          peerCertificateChainCaptureComplete:
            value.peerCertificateChainCaptureComplete,
        }),
    ...(value.omittedPeerCertificateCount === undefined
      ? {}
      : { omittedPeerCertificateCount: value.omittedPeerCertificateCount }),
  };
}

/** Projects a successful proxy terminal frame onto backend persistence input. */
function transportResultFromComplete(
  head: ResponseHead,
  complete: ResponseComplete,
): ExecutionTransportResult {
  return {
    collected: complete.transportMetadataCollected,
    ...(complete.transportMetadataUnavailableReason === undefined
      ? {}
      : { unavailableReason: complete.transportMetadataUnavailableReason }),
    timings: complete.timings,
    ...(head.transport === undefined ? {} : { observation: head.transport }),
  };
}

/** Retains proxy observations and timings from a terminal execution failure. */
function transportResultFromFailure(
  head: ResponseHead | undefined,
  cause: unknown,
): ExecutionTransportResult {
  if (cause instanceof ProxyExecutionError) {
    const observation = cause.detail.transport ?? head?.transport;
    return {
      collected: cause.detail.transportMetadataCollected,
      ...(cause.detail.transportMetadataUnavailableReason === undefined
        ? {}
        : {
            unavailableReason: cause.detail.transportMetadataUnavailableReason,
          }),
      timings: cause.detail.timings,
      ...(observation === undefined ? {} : { observation }),
    };
  }
  return {
    collected: head?.transport !== undefined,
    ...(head?.transport === undefined ? {} : { observation: head.transport }),
  };
}

/** Decodes a canonical non-empty Base64 string at the proxy trust boundary. */
function decodeCanonicalBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length > Math.ceil(MAX_TRANSPORT_CERTIFICATE_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw new Error("Proxy certificate DER is not canonical Base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("Proxy certificate DER is not canonical Base64");
  }
  return decoded;
}

/** Parses optional display fields after validating canonical X.509 DER. */
function certificateSummary(
  der: Buffer,
  sha256Fingerprint: string,
  chainPosition: number,
): BackendComponents["schemas"]["ExecutionCertificateSummary"] {
  const identity = { sha256Fingerprint, chainPosition };
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(der);
  } catch (cause) {
    throw new Error("Proxy certificate DER is not a valid X.509 certificate", {
      cause,
    });
  }
  const validFrom = validCertificateDate(certificate.validFrom);
  const validTo = validCertificateDate(certificate.validTo);
  const subjectAlternativeNames = splitSubjectAlternativeNames(
    certificate.subjectAltName,
  );
  return {
    ...identity,
    ...(certificate.subject.length === 0
      ? {}
      : { subject: certificate.subject }),
    ...(certificate.issuer.length === 0 ? {} : { issuer: certificate.issuer }),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validTo === undefined ? {} : { validTo }),
    ...(certificate.serialNumber.length === 0
      ? {}
      : { serialNumber: certificate.serialNumber }),
    ...(subjectAlternativeNames.length === 0
      ? {}
      : { subjectAlternativeNames }),
  };
}

/** Converts a runtime certificate date to canonical UTC when it is valid. */
function validCertificateDate(value: string): string | undefined {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : undefined;
}

/** Splits Node's safely quoted subject-alt-name display without losing commas. */
function splitSubjectAlternativeNames(value: string | undefined): string[] {
  if (value === undefined || value.length === 0) return [];
  const names: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === "," && value[index + 1] === " ") {
      names.push(value.slice(start, index));
      start = index + 2;
      index += 1;
    }
  }
  names.push(value.slice(start));
  return names.filter((name) => name.length > 0);
}

/** Removes plaintext from one committed write before it enters execution results. */
function scriptVariableWriteResult(
  write: ScriptVariableWrite,
): ScriptVariableWriteResult {
  return { name: write.name, scope: write.scope, kind: write.kind };
}

/** Converts a sensitivity-aware script view into a user-inspectable request. */
function outgoingRequestView(
  request: ScriptRequest,
  materialized: PreparedExecution["request"],
): OutgoingRequestView {
  const bodyBytes =
    materialized.bodyBytes === undefined
      ? Buffer.from(materialized.body, "utf8")
      : Buffer.from(materialized.bodyBytes);
  const bodyRedacted = request.body.sensitive || !request.body.readable;
  const bodyValue =
    materialized.bodyBytes === undefined
      ? materialized.body
      : bodyBytes.toString("base64");
  return {
    method: materialized.method,
    url: {
      value:
        request.url.readable && request.url.value !== undefined
          ? request.url.value
          : "[secret]",
      redacted: request.url.sensitive || !request.url.readable,
    },
    headers: [
      {
        name: "Host",
        value: request.url.sensitive
          ? "[secret]"
          : new URL(materialized.targetUrl).host,
        redacted: request.url.sensitive,
        derived: true,
      },
      ...request.headers.flatMap((header, index) => {
        if (materialized.headers[index]?.enabled !== true) return [];
        return [
          {
            name: header.name,
            value:
              header.readable && header.value !== undefined
                ? header.value
                : "[secret]",
            redacted: header.sensitive || !header.readable,
            derived: false,
          },
        ];
      }),
    ],
    body: {
      value: bodyRedacted
        ? "[secret]"
        : bodyValue.slice(0, OUTGOING_BODY_PREVIEW_CHARACTERS),
      encoding:
        materialized.bodyBytes === undefined ? "utf8" : ("base64" as const),
      byteLength: bodyBytes.byteLength,
      redacted: bodyRedacted,
      truncated:
        !bodyRedacted && bodyValue.length > OUTGOING_BODY_PREVIEW_CHARACTERS,
    },
  };
}

/** Adds the product User-Agent unless an enabled request field already supplies one. */
function withDefaultUserAgent(
  request: PreparedExecution["request"],
): PreparedExecution["request"] {
  if (
    request.headers.some(
      (header) => header.enabled && header.name.toLowerCase() === "user-agent",
    )
  ) {
    return request;
  }
  return {
    ...request,
    headers: [
      ...request.headers,
      { name: "User-Agent", value: DEFAULT_BACKEND_USER_AGENT, enabled: true },
    ],
  };
}

/** Attaches private host diagnostics to a user-safe script execution error. */
function scriptHostError(
  code: "runtime_error" | "response_body_unavailable",
  message: string,
  cause: unknown,
): ScriptExecutionError {
  const error = new ScriptExecutionError(code, message);
  if (cause instanceof Error) {
    Object.defineProperty(error, "cause", {
      configurable: false,
      enumerable: false,
      value: cause,
      writable: false,
    });
  }
  return error;
}

/** Materializes enabled structured query fields into the final target URL. */
function materializeTargetUrl(
  targetUrl: string,
  query: PreparedExecution["request"]["query"],
): string {
  const url = new URL(targetUrl);
  for (const field of query) {
    if (field.enabled) {
      url.searchParams.append(field.name, field.value);
    }
  }
  return url.toString();
}

/** Maps proxy and internal failures to a stable execution error contract. */
function toExecutionError(cause: unknown): {
  readonly code: string;
  readonly message: string;
} {
  if (cause instanceof ProxyExecutionError) {
    return { code: cause.detail.code, message: cause.detail.message };
  }
  if (cause instanceof ScriptExecutionError) {
    return { code: `script_${cause.code}`, message: cause.message };
  }
  return {
    code: "execution_failed",
    message: cause instanceof Error ? cause.message : "Execution failed",
  };
}

/** Decodes bounded valid UTF-8 evidence without interpreting its media type. */
export function safeUtf8Preview(bytes: Buffer): string | undefined {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return hasDisallowedTextControls(value) ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Detects controls that make otherwise valid UTF-8 unsafe as textual evidence. */
function hasDisallowedTextControls(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0x7f ||
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f)
    ) {
      return true;
    }
  }
  return false;
}
