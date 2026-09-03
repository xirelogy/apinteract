import type { Kysely, Transaction } from "kysely";

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
} from "./script-execution-adapter.js";

type ResponseHead = ProxyComponents["schemas"]["ResponseHead"];
type ResponseComplete = ProxyComponents["schemas"]["ResponseComplete"];
/** Maximum characters retained in the WebSocket-safe outgoing body preview. */
const OUTGOING_BODY_PREVIEW_CHARACTERS = 262_144;

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
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly errors: readonly [];
  };
  readonly outgoingRequest?: OutgoingRequestView;
  readonly scriptLogs: readonly PhasedScriptLog[];
  readonly scriptTests: readonly ScriptTestResult[];
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
  ): Promise<ExecutionView> {
    const completedAt = Date.now();
    // The file is committed before this transaction. Blob metadata, its
    // execution reference, terminal state, and audit outbox entry are then
    // committed atomically. Crash recovery may need to remove an orphan file
    // that was renamed before this transaction began.
    await this.#database.transaction().execute(async (transaction) => {
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
          script_result_json: JSON.stringify(scripts),
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
      ...(error === null ? {} : { error: { ...error, errors: [] as const } }),
      ...(outgoingRequest === undefined ? {} : { outgoingRequest }),
      scriptLogs: scripts.logs,
      scriptTests: scripts.tests,
      ...(scripts.error === undefined ? {} : { scriptError: scripts.error }),
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
