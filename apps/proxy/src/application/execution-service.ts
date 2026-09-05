import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

import type { components } from "@apinteract/api-contracts/proxy";
import { v7 as uuidV7 } from "uuid";

import type { ProxyLimitsConfiguration } from "../config.js";
import {
  FRAME_HEADER_BYTES,
  FrameStore,
  FrameType,
  MAX_FRAME_PAYLOAD_BYTES,
} from "../protocol/frame-store.js";
import { DEFAULT_PROXY_USER_AGENT } from "../version.js";
import { type TargetApprover, TargetResolutionError } from "./target-policy.js";

type CreateExecutionRequest = components["schemas"]["CreateExecutionRequest"];
type ExecutionSession = components["schemas"]["ExecutionSession"];
type TargetRequest = components["schemas"]["TargetRequest"];
type ExecutionStreamError = components["schemas"]["ExecutionStreamError"];

const TERMINAL_FRAME_RESERVE_BYTES = 4_096;
const MAX_EXPIRY_TOMBSTONES = 10_000;
const FORBIDDEN_TARGET_HEADERS = new Set([
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

interface ManagedExecution {
  readonly id: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly descriptorHash: string;
  readonly createdAt: string;
  readonly frameStore: FrameStore;
  readonly target: TargetRequest;
  cacheBytes: number;
  terminalReserveBytes: number;
  terminating: boolean;
  state: ExecutionSession["state"];
  requestBodyState: ExecutionSession["requestBodyState"];
  responseState: ExecutionSession["responseState"];
  error: ExecutionStreamError | null;
  expiresAt: string | null;
  request?: ClientRequest;
  totalTimer?: NodeJS.Timeout;
  expiryTimer?: NodeJS.Timeout;
  responseReaderActive: boolean;
}

interface PendingExecutionCreation {
  readonly descriptorHash: string;
  readonly result: Promise<{
    readonly session: ExecutionSession;
    readonly replayed: false;
  }>;
}

interface ExpiredExecutionTombstone {
  readonly principalId: string;
  readonly timer: NodeJS.Timeout;
}

/** Exclusive leased access to one execution's resumable response frames. */
export interface ExecutionResponseReader {
  readonly frames: AsyncGenerator<Buffer>;
  /** Releases the reader lease and aborts any pending frame wait. */
  close(): void;
}

interface ExecutionFailureOptions {
  readonly category: ExecutionStreamError["category"];
  readonly code: string;
  readonly message: string;
  readonly phase: ExecutionStreamError["phase"];
  readonly retryable: boolean;
}

/** Dependencies and enforceable limits owned by one execution service. */
export interface ExecutionServiceOptions {
  readonly cachePath: string;
  readonly retentionMs: number;
  readonly limits: ProxyLimitsConfiguration;
  readonly targetPolicy: TargetApprover;
  readonly reportCleanupError?: (cause: unknown) => void;
}

/** Raised when one principal reuses an idempotency key for different input. */
export class IdempotencyConflictError extends Error {}

/** Raised when a request body upload conflicts with execution state or metadata. */
export class RequestBodyUploadError extends Error {}

/** Raised when public execution input exceeds an advertised size ceiling. */
export class ExecutionInputLimitError extends Error {
  readonly code: "request_body_limit_exceeded" | "request_metadata_invalid";

  constructor(code: ExecutionInputLimitError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** Raised when a principal has exhausted an advertised transient resource. */
export class PrincipalCapacityError extends Error {}
/** Raised when an owned response cache has passed its retention deadline. */
export class ExecutionExpiredError extends Error {}
/** Raised while another client holds the execution's response-reader lease. */
export class ExecutionResponseReaderConflictError extends Error {}

/** Internal typed failure projected onto a safe terminal stream error. */
class ExecutionFailure extends Error {
  readonly detail: ExecutionFailureOptions;

  constructor(detail: ExecutionFailureOptions) {
    super(detail.message);
    this.detail = detail;
  }
}

/** Internal signal that the principal's response-frame budget is exhausted. */
class CacheCapacityError extends Error {}

/**
 * Owns transient target executions and their replayable response frames.
 *
 * Every lookup, execution slot, and cache byte is scoped to the authenticated
 * backend principal. Target I/O uses a policy-approved pinned DNS result.
 * Terminal executions retain frames only until explicit release or expiry.
 */
export class ExecutionService {
  readonly #cachePath: string;
  readonly #retentionMs: number;
  readonly #limits: ProxyLimitsConfiguration;
  readonly #targetPolicy: TargetApprover;
  readonly #reportCleanupError: (cause: unknown) => void;
  readonly #executions = new Map<string, ManagedExecution>();
  readonly #idempotency = new Map<string, string>();
  readonly #pendingCreations = new Map<string, PendingExecutionCreation>();
  readonly #expiredExecutions = new Map<string, ExpiredExecutionTombstone>();
  readonly #executionCounts = new Map<string, number>();
  readonly #cacheBytes = new Map<string, number>();
  readonly #reservedCacheBytes = new Map<string, number>();

  constructor(options: ExecutionServiceOptions) {
    this.#cachePath = options.cachePath;
    this.#retentionMs = options.retentionMs;
    this.#limits = options.limits;
    this.#targetPolicy = options.targetPolicy;
    this.#reportCleanupError = options.reportCleanupError ?? (() => undefined);
  }

  /** Removes cache files left by a prior process whose in-memory state is gone. */
  async initialize(): Promise<void> {
    await mkdir(this.#cachePath, { recursive: true });
    const entries = await readdir(this.#cachePath, { withFileTypes: true });
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.frames$/i.test(
              entry.name,
            ),
        )
        .map((entry) => rm(join(this.#cachePath, entry.name), { force: true })),
    );
  }

  /** Creates or idempotently replays one principal-owned target execution. */
  async create(
    principalId: string,
    idempotencyKey: string,
    descriptor: CreateExecutionRequest,
  ): Promise<{
    readonly session: ExecutionSession;
    readonly replayed: boolean;
  }> {
    this.#validateDescriptor(descriptor);
    // Principal scoping allows separate backend instances to use the same
    // idempotency key without observing or affecting each other's execution.
    const key = `${principalId}:${idempotencyKey}`;
    const descriptorHash = createHash("sha256")
      .update(JSON.stringify(descriptor))
      .digest("hex");
    const existingId = this.#idempotency.get(key);
    if (existingId !== undefined) {
      const existing = this.#executions.get(existingId);
      if (existing === undefined) {
        this.#idempotency.delete(key);
      } else if (existing.descriptorHash !== descriptorHash) {
        throw new IdempotencyConflictError(
          "The idempotency key was already used with a different descriptor",
        );
      } else {
        return { session: this.#toSession(existing), replayed: true };
      }
    }

    const pending = this.#pendingCreations.get(key);
    if (pending !== undefined) {
      if (pending.descriptorHash !== descriptorHash) {
        throw new IdempotencyConflictError(
          "The idempotency key is being used with a different descriptor",
        );
      }
      return { session: (await pending.result).session, replayed: true };
    }

    const result = this.#createExecution(
      principalId,
      idempotencyKey,
      descriptor,
      descriptorHash,
      key,
    );
    const creation = { descriptorHash, result };
    this.#pendingCreations.set(key, creation);
    try {
      return await result;
    } finally {
      if (this.#pendingCreations.get(key) === creation) {
        this.#pendingCreations.delete(key);
      }
    }
  }

  /** Allocates one new execution after its idempotency key is exclusively held. */
  async #createExecution(
    principalId: string,
    idempotencyKey: string,
    descriptor: CreateExecutionRequest,
    descriptorHash: string,
    key: string,
  ): Promise<{ readonly session: ExecutionSession; readonly replayed: false }> {
    this.#reserveExecution(principalId);
    const id = uuidV7();
    let frameStore: FrameStore;
    try {
      frameStore = await FrameStore.create(
        join(this.#cachePath, `${id}.frames`),
      );
    } catch (cause) {
      this.#releaseExecutionReservation(principalId);
      throw cause;
    }
    const execution: ManagedExecution = {
      id,
      principalId,
      idempotencyKey,
      descriptorHash,
      createdAt: new Date().toISOString(),
      frameStore,
      state: descriptor.request.body.mode === "none" ? "active" : "accepted",
      requestBodyState:
        descriptor.request.body.mode === "none"
          ? "not_required"
          : "awaiting_upload",
      responseState: "waiting",
      error: null,
      expiresAt: null,
      target: descriptor.request,
      cacheBytes: 0,
      terminalReserveBytes: TERMINAL_FRAME_RESERVE_BYTES,
      terminating: false,
      responseReaderActive: false,
    };
    this.#executions.set(id, execution);
    this.#idempotency.set(key, id);
    this.#startTotalTimer(execution);
    // Creation returns as soon as replay state exists. Target I/O continues
    // independently and is observed through the response data plane.
    if (descriptor.request.body.mode === "none") {
      void this.#run(execution, Buffer.alloc(0)).catch(
        this.#reportCleanupError,
      );
    }
    return { session: this.#toSession(execution), replayed: false };
  }

  /** Accepts and validates one complete raw request body before target I/O. */
  upload(
    principalId: string,
    executionId: string,
    body: Buffer,
  ): ExecutionSession | undefined {
    const execution = this.#owned(principalId, executionId);
    if (execution === undefined) {
      return undefined;
    }
    if (
      execution.requestBodyState !== "awaiting_upload" ||
      execution.target.body.mode !== "stream"
    ) {
      throw new RequestBodyUploadError(
        "Execution is not accepting a request body",
      );
    }
    if (body.byteLength > this.#limits.maxRequestBodyBytes) {
      throw new ExecutionInputLimitError(
        "request_body_limit_exceeded",
        "Request body exceeds the effective principal limit",
      );
    }
    const descriptor = execution.target.body;
    if (descriptor.length !== null && descriptor.length !== body.byteLength) {
      throw new RequestBodyUploadError(
        "Request body length does not match its descriptor",
      );
    }
    if (
      descriptor.sha256 !== null &&
      createHash("sha256").update(body).digest("hex") !== descriptor.sha256
    ) {
      throw new RequestBodyUploadError(
        "Request body digest does not match its descriptor",
      );
    }
    execution.requestBodyState = "complete";
    execution.state = "active";
    void this.#run(execution, body).catch(this.#reportCleanupError);
    return this.#toSession(execution);
  }

  /** Returns current execution state only to its owning principal. */
  get(principalId: string, executionId: string): ExecutionSession | undefined {
    const execution = this.#owned(principalId, executionId);
    return execution === undefined ? undefined : this.#toSession(execution);
  }

  /** Opens a resumable response-frame reader for an owned execution. */
  stream(
    principalId: string,
    executionId: string,
    afterSequence: number,
  ): ExecutionResponseReader | undefined {
    const execution = this.#owned(principalId, executionId);
    if (execution === undefined) {
      if (
        this.#expiredExecutions.get(executionId)?.principalId === principalId
      ) {
        throw new ExecutionExpiredError(
          "The execution response cache has expired",
        );
      }
      return undefined;
    }
    if (execution.responseReaderActive) {
      throw new ExecutionResponseReaderConflictError(
        "A response reader is already active for this execution",
      );
    }
    execution.responseReaderActive = true;
    const controller = new AbortController();
    let closed = false;
    /** Releases the response-reader lease and wakes any waiting consumer. */
    const close = () => {
      if (closed) return;
      closed = true;
      execution.responseReaderActive = false;
      controller.abort();
    };
    return {
      frames: this.#readResponseFrames(
        execution,
        afterSequence,
        controller.signal,
        close,
      ),
      close,
    };
  }

  /** Releases the reader lease when replay completes, fails, or is cancelled. */
  async *#readResponseFrames(
    execution: ManagedExecution,
    afterSequence: number,
    signal: AbortSignal,
    close: () => void,
  ): AsyncGenerator<Buffer> {
    try {
      yield* execution.frameStore.readAfter(afterSequence, signal);
    } finally {
      close();
    }
  }

  /** Requests best-effort cancellation of an owned active or accepted execution. */
  async cancel(
    principalId: string,
    executionId: string,
  ): Promise<ExecutionSession | undefined> {
    const execution = this.#owned(principalId, executionId);
    if (execution === undefined) {
      return undefined;
    }
    if (!this.#isTerminal(execution)) {
      execution.request?.destroy(
        new ExecutionFailure({
          category: "proxy",
          code: "execution_cancelled",
          message: "The execution was cancelled.",
          phase: "internal",
          retryable: false,
        }),
      );
      await this.#fail(
        execution,
        {
          category: "proxy",
          code: "execution_cancelled",
          message: "The execution was cancelled.",
          phase: "internal",
          retryable: false,
        },
        "cancelled",
      );
    }
    return this.#toSession(execution);
  }

  /** Releases terminal execution state, frames, quotas, and idempotency mapping. */
  async release(principalId: string, executionId: string): Promise<boolean> {
    const execution = this.#owned(principalId, executionId);
    if (execution === undefined) {
      return false;
    }
    if (!this.#isTerminal(execution)) {
      throw new Error("Execution is not terminal");
    }
    await this.#releaseExecution(execution);
    return true;
  }

  /** Stops target I/O and releases every transient file during server shutdown. */
  async close(): Promise<void> {
    const executions = [...this.#executions.values()];
    for (const execution of executions) {
      execution.request?.destroy(new Error("Proxy is shutting down"));
      await this.#releaseExecution(execution);
    }
    for (const tombstone of this.#expiredExecutions.values()) {
      clearTimeout(tombstone.timer);
    }
    this.#expiredExecutions.clear();
  }

  /** Performs policy-approved target HTTP I/O and records its terminal response. */
  async #run(execution: ManagedExecution, requestBody: Buffer): Promise<void> {
    try {
      const target = execution.target;
      const url = new URL(target.url);
      const approved = await this.#targetPolicy.approve(url);
      if (this.#isTerminal(execution)) {
        return;
      }
      const headers = this.#toNodeHeaders(target.headers);
      if (
        !target.headers.some(({ name }) => name.toLowerCase() === "user-agent")
      ) {
        headers["User-Agent"] = DEFAULT_PROXY_USER_AGENT;
      }
      if (target.body.mode === "stream" && target.body.length !== null) {
        headers["Content-Length"] = String(target.body.length);
      }

      const response = await this.#openResponse(
        execution,
        url,
        approved.lookup,
        headers,
        requestBody,
      );
      if (this.#isTerminal(execution)) {
        response.destroy();
        return;
      }
      execution.responseState = "streaming";
      await this.#appendJson(execution, FrameType.ResponseHead, {
        status: response.statusCode ?? 500,
        reasonPhrase: response.statusMessage ?? null,
        httpVersion: "HTTP/1.1",
        headers: this.#orderedResponseHeaders(response),
        receivedAt: new Date().toISOString(),
      });

      const digest = createHash("sha256");
      let bodyBytes = 0;
      const responseLimit = Math.min(
        target.behavior.maxResponseBodyBytes,
        this.#limits.maxResponseBodyBytes,
      );
      for await (const chunk of response as AsyncIterable<Uint8Array>) {
        const bytes = Buffer.from(chunk);
        bodyBytes += bytes.byteLength;
        if (bodyBytes > responseLimit) {
          throw new ExecutionFailure({
            category: "proxy",
            code: "response_body_limit_exceeded",
            message: "The target response exceeded the response-body limit.",
            phase: "response",
            retryable: false,
          });
        }
        digest.update(bytes);
        for (
          let offset = 0;
          offset < bytes.byteLength;
          offset += MAX_FRAME_PAYLOAD_BYTES
        ) {
          await this.#appendFrame(
            execution,
            FrameType.Body,
            bytes.subarray(offset, offset + MAX_FRAME_PAYLOAD_BYTES),
          );
        }
      }
      await this.#appendJson(
        execution,
        FrameType.Complete,
        {
          bodyBytes,
          bodySha256: digest.digest("hex"),
          timings: {},
          completedAt: new Date().toISOString(),
        },
        true,
      );
      this.#markTerminal(execution, "completed", "complete", null);
    } catch (cause) {
      if (this.#isTerminal(execution)) {
        return;
      }
      const failure = this.#toFailure(cause, execution.responseState);
      await this.#fail(execution, failure);
    }
  }

  /** Opens a target request with distinct connection and response-head timers. */
  #openResponse(
    execution: ManagedExecution,
    url: URL,
    lookup: NonNullable<Parameters<typeof httpRequest>[1]>["lookup"],
    headers: Record<string, string | string[]>,
    requestBody: Buffer,
  ): Promise<IncomingMessage> {
    const target = execution.target;
    const requestFunction =
      url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      let responseHeaderTimer: NodeJS.Timeout | undefined;
      const connectTimer = setTimeout(() => {
        request.destroy(
          new ExecutionFailure({
            category: "network",
            code: "connect_timeout",
            message: "The target connection timed out.",
            phase: "connect",
            retryable: true,
          }),
        );
      }, target.behavior.connectTimeoutMs);
      connectTimer.unref();
      const request = requestFunction(
        url,
        {
          method: target.method,
          headers,
          lookup,
          rejectUnauthorized: target.behavior.tlsVerification === "strict",
        },
        (response) => {
          clearTimeout(connectTimer);
          if (responseHeaderTimer !== undefined) {
            clearTimeout(responseHeaderTimer);
          }
          const socket = response.socket;
          response.setTimeout(target.behavior.responseIdleTimeoutMs, () => {
            response.destroy(
              new ExecutionFailure({
                category: "network",
                code: "response_idle_timeout",
                message: "The target response became idle.",
                phase: "response",
                retryable: true,
              }),
            );
          });
          /** Clears the captured socket timer even after Node detaches it. */
          const clearIdleTimeout = (): void => {
            socket.setTimeout(0);
          };
          response.once("end", clearIdleTimeout);
          response.once("aborted", clearIdleTimeout);
          response.once("error", clearIdleTimeout);
          response.once("close", clearIdleTimeout);
          resolve(response);
        },
      );
      execution.request = request;
      request.once("socket", (socket) => {
        /** Starts response-head timing after transport connection establishment. */
        const connected = (): void => {
          clearTimeout(connectTimer);
          responseHeaderTimer = setTimeout(() => {
            request.destroy(
              new ExecutionFailure({
                category: "network",
                code: "response_header_timeout",
                message: "The target did not send response headers in time.",
                phase: "response",
                retryable: true,
              }),
            );
          }, target.behavior.responseHeaderTimeoutMs);
          responseHeaderTimer.unref();
        };
        if (url.protocol === "https:") {
          socket.once("secureConnect", connected);
        } else if (socket.connecting) {
          socket.once("connect", connected);
        } else {
          connected();
        }
      });
      request.once("error", (cause) => {
        clearTimeout(connectTimer);
        if (responseHeaderTimer !== undefined) {
          clearTimeout(responseHeaderTimer);
        }
        reject(cause);
      });
      request.end(requestBody);
    });
  }

  /** Validates custom OpenAPI extensions and effective per-principal ceilings. */
  #validateDescriptor(descriptor: CreateExecutionRequest): void {
    const target = descriptor.request;
    if (target.headers.length > this.#limits.maxRequestHeaderCount) {
      throw new ExecutionInputLimitError(
        "request_metadata_invalid",
        "Target request contains too many header fields",
      );
    }
    if (
      target.headers.some(({ name }) =>
        FORBIDDEN_TARGET_HEADERS.has(name.toLowerCase()),
      )
    ) {
      throw new ExecutionInputLimitError(
        "request_metadata_invalid",
        "Target request contains a transport-owned or hop-by-hop header",
      );
    }
    if (
      target.body.length !== null &&
      target.body.length > this.#limits.maxRequestBodyBytes
    ) {
      throw new ExecutionInputLimitError(
        "request_body_limit_exceeded",
        "Request body descriptor exceeds the effective principal limit",
      );
    }
    if (
      target.behavior.maxResponseBodyBytes > this.#limits.maxResponseBodyBytes
    ) {
      throw new ExecutionInputLimitError(
        "request_metadata_invalid",
        "Requested response-body limit exceeds the effective principal limit",
      );
    }
  }

  /** Reserves one retained execution and terminal-frame cache allowance. */
  #reserveExecution(principalId: string): void {
    const count = this.#executionCounts.get(principalId) ?? 0;
    const bytes = this.#cacheBytes.get(principalId) ?? 0;
    const reserved = this.#reservedCacheBytes.get(principalId) ?? 0;
    if (count >= this.#limits.maxConcurrentExecutionsPerPrincipal) {
      throw new PrincipalCapacityError(
        "The principal has reached its concurrent execution limit",
      );
    }
    if (
      bytes + reserved + TERMINAL_FRAME_RESERVE_BYTES >
      this.#limits.maxCacheBytesPerPrincipal
    ) {
      throw new PrincipalCapacityError(
        "The principal has reached its response-cache limit",
      );
    }
    this.#executionCounts.set(principalId, count + 1);
    this.#reservedCacheBytes.set(
      principalId,
      reserved + TERMINAL_FRAME_RESERVE_BYTES,
    );
  }

  /** Rolls back resources reserved before a frame store was created. */
  #releaseExecutionReservation(principalId: string): void {
    this.#decrement(this.#executionCounts, principalId, 1);
    this.#decrement(
      this.#reservedCacheBytes,
      principalId,
      TERMINAL_FRAME_RESERVE_BYTES,
    );
  }

  /** Appends one cache-accounted response frame. */
  async #appendFrame(
    execution: ManagedExecution,
    type: FrameType,
    payload: Buffer,
    terminal = false,
  ): Promise<number> {
    const frameBytes = FRAME_HEADER_BYTES + payload.byteLength;
    const releasedReserve = this.#reserveFrameBytes(
      execution,
      frameBytes,
      terminal,
    );
    try {
      return await execution.frameStore.append(type, payload, terminal);
    } catch (cause) {
      this.#rollbackFrameBytes(execution, frameBytes, releasedReserve);
      throw cause;
    }
  }

  /** Serializes and appends one cache-accounted JSON response frame. */
  #appendJson(
    execution: ManagedExecution,
    type: FrameType,
    value: unknown,
    terminal = false,
  ): Promise<number> {
    return this.#appendFrame(
      execution,
      type,
      Buffer.from(JSON.stringify(value)),
      terminal,
    );
  }

  /** Atomically reserves principal cache bytes before asynchronous file I/O. */
  #reserveFrameBytes(
    execution: ManagedExecution,
    frameBytes: number,
    terminal: boolean,
  ): number {
    const principalId = execution.principalId;
    const used = this.#cacheBytes.get(principalId) ?? 0;
    let reserved = this.#reservedCacheBytes.get(principalId) ?? 0;
    const releasedReserve = terminal ? execution.terminalReserveBytes : 0;
    reserved -= releasedReserve;
    if (used + reserved + frameBytes > this.#limits.maxCacheBytesPerPrincipal) {
      throw new CacheCapacityError("Principal response-cache limit exceeded");
    }
    execution.terminalReserveBytes -= releasedReserve;
    execution.cacheBytes += frameBytes;
    this.#reservedCacheBytes.set(principalId, reserved);
    this.#cacheBytes.set(principalId, used + frameBytes);
    return releasedReserve;
  }

  /** Restores quota accounting after a frame-store append failure. */
  #rollbackFrameBytes(
    execution: ManagedExecution,
    frameBytes: number,
    releasedReserve: number,
  ): void {
    execution.cacheBytes -= frameBytes;
    execution.terminalReserveBytes += releasedReserve;
    this.#decrement(this.#cacheBytes, execution.principalId, frameBytes);
    this.#reservedCacheBytes.set(
      execution.principalId,
      (this.#reservedCacheBytes.get(execution.principalId) ?? 0) +
        releasedReserve,
    );
  }

  /** Converts internal and Node transport errors to stable safe stream failures. */
  #toFailure(
    cause: unknown,
    responseState: ExecutionSession["responseState"],
  ): ExecutionFailureOptions {
    if (cause instanceof ExecutionFailure) {
      return cause.detail;
    }
    if (cause instanceof TargetResolutionError) {
      return {
        category: cause.code === "dns_resolution_failed" ? "network" : "proxy",
        code: cause.code,
        message: cause.message,
        phase: cause.phase,
        retryable: cause.retryable,
      };
    }
    if (cause instanceof CacheCapacityError) {
      return {
        category: "proxy",
        code: "proxy_capacity_exceeded",
        message: "The principal response-cache limit was reached.",
        phase: "cache",
        retryable: false,
      };
    }
    const systemCode = (cause as NodeJS.ErrnoException | undefined)?.code;
    const known = this.#knownNetworkFailure(systemCode);
    if (known !== undefined) {
      return known;
    }
    return {
      category: "network",
      code: "target_request_failed",
      message: "The target request failed.",
      phase: responseState === "streaming" ? "response" : "connect",
      retryable: false,
    };
  }

  /** Maps common Node error codes without exposing raw socket error messages. */
  #knownNetworkFailure(
    code: string | undefined,
  ): ExecutionFailureOptions | undefined {
    if (code === "ECONNREFUSED") {
      return {
        category: "network",
        code: "connection_refused",
        message: "The target refused the connection.",
        phase: "connect",
        retryable: true,
      };
    }
    if (code === "ECONNRESET" || code === "EPIPE") {
      return {
        category: "network",
        code: "connection_reset",
        message: "The target connection was reset.",
        phase: "response",
        retryable: true,
      };
    }
    if (code?.startsWith("ERR_TLS") === true || code === "CERT_HAS_EXPIRED") {
      return {
        category: "network",
        code: "tls_handshake_failed",
        message: "The target TLS handshake failed.",
        phase: "tls",
        retryable: false,
      };
    }
    return undefined;
  }

  /** Writes a terminal error frame and begins configured retention. */
  async #fail(
    execution: ManagedExecution,
    failure: ExecutionFailureOptions,
    state: "failed" | "cancelled" = "failed",
  ): Promise<void> {
    if (this.#isTerminal(execution) || execution.terminating) {
      return;
    }
    execution.terminating = true;
    const error: ExecutionStreamError = failure;
    execution.error = error;
    try {
      if (!execution.frameStore.terminal) {
        await this.#appendJson(execution, FrameType.Error, error, true);
      }
    } finally {
      this.#markTerminal(
        execution,
        state,
        state === "cancelled" ? "cancelled" : "failed",
        error,
      );
      execution.terminating = false;
    }
  }

  /** Starts the total lifetime deadline at execution creation. */
  #startTotalTimer(execution: ManagedExecution): void {
    execution.totalTimer = setTimeout(() => {
      const failure: ExecutionFailureOptions = {
        category: "network",
        code: "total_timeout",
        message: "The execution exceeded its total time limit.",
        phase: execution.state === "accepted" ? "upload" : "internal",
        retryable: true,
      };
      execution.request?.destroy(new ExecutionFailure(failure));
      void this.#fail(execution, failure).catch(this.#reportCleanupError);
    }, execution.target.behavior.totalTimeoutMs);
    execution.totalTimer.unref();
  }

  /** Records a terminal transition exactly once and schedules expiry cleanup. */
  #markTerminal(
    execution: ManagedExecution,
    state: "completed" | "failed" | "cancelled",
    responseState: "complete" | "failed" | "cancelled",
    error: ExecutionStreamError | null,
  ): void {
    if (this.#isTerminal(execution)) {
      return;
    }
    if (execution.totalTimer !== undefined) {
      clearTimeout(execution.totalTimer);
      delete execution.totalTimer;
    }
    delete execution.request;
    execution.state = state;
    execution.responseState = responseState;
    execution.error = error;
    execution.expiresAt = new Date(
      Date.now() + this.#retentionMs,
    ).toISOString();
    execution.expiryTimer = setTimeout(() => {
      void this.#expireExecution(execution).catch(this.#reportCleanupError);
    }, this.#retentionMs);
    execution.expiryTimer.unref();
  }

  /** Reports whether an execution has entered an immutable terminal state. */
  #isTerminal(execution: ManagedExecution): boolean {
    return (
      execution.state === "completed" ||
      execution.state === "failed" ||
      execution.state === "cancelled"
    );
  }

  /** Resolves an execution only when its immutable principal owner matches. */
  #owned(
    principalId: string,
    executionId: string,
  ): ManagedExecution | undefined {
    const execution = this.#executions.get(executionId);
    return execution?.principalId === principalId ? execution : undefined;
  }

  /** Removes one execution and returns all of its accounted resources. */
  async #releaseExecution(execution: ManagedExecution): Promise<void> {
    if (this.#executions.get(execution.id) !== execution) {
      return;
    }
    this.#executions.delete(execution.id);
    this.#idempotency.delete(
      `${execution.principalId}:${execution.idempotencyKey}`,
    );
    if (execution.totalTimer !== undefined) {
      clearTimeout(execution.totalTimer);
    }
    if (execution.expiryTimer !== undefined) {
      clearTimeout(execution.expiryTimer);
    }
    this.#decrement(this.#executionCounts, execution.principalId, 1);
    this.#decrement(
      this.#cacheBytes,
      execution.principalId,
      execution.cacheBytes,
    );
    this.#decrement(
      this.#reservedCacheBytes,
      execution.principalId,
      execution.terminalReserveBytes,
    );
    await execution.frameStore.dispose();
  }

  /** Releases transient data and retains a bounded owner-only expiry marker. */
  async #expireExecution(execution: ManagedExecution): Promise<void> {
    if (this.#executions.get(execution.id) !== execution) return;
    this.#retainExpiryTombstone(execution.id, execution.principalId);
    await this.#releaseExecution(execution);
  }

  /** Retains an expiry distinction temporarily without request or response data. */
  #retainExpiryTombstone(executionId: string, principalId: string): void {
    while (this.#expiredExecutions.size >= MAX_EXPIRY_TOMBSTONES) {
      const oldestId = this.#expiredExecutions.keys().next().value;
      if (oldestId === undefined) break;
      const oldest = this.#expiredExecutions.get(oldestId);
      if (oldest !== undefined) clearTimeout(oldest.timer);
      this.#expiredExecutions.delete(oldestId);
    }
    const tombstone: ExpiredExecutionTombstone = {
      principalId,
      timer: setTimeout(() => {
        if (this.#expiredExecutions.get(executionId) === tombstone) {
          this.#expiredExecutions.delete(executionId);
        }
      }, this.#retentionMs),
    };
    tombstone.timer.unref();
    this.#expiredExecutions.set(executionId, tombstone);
  }

  /** Subtracts an accounted value and removes empty principal entries. */
  #decrement(map: Map<string, number>, key: string, amount: number): void {
    const remaining = (map.get(key) ?? 0) - amount;
    if (remaining <= 0) {
      map.delete(key);
    } else {
      map.set(key, remaining);
    }
  }

  /** Projects mutable execution state onto the public session contract. */
  #toSession(execution: ManagedExecution): ExecutionSession {
    return {
      executionId: execution.id,
      state: execution.state,
      requestBodyState: execution.requestBodyState,
      responseState: execution.responseState,
      createdAt: execution.createdAt,
      expiresAt: execution.expiresAt,
      error: execution.error,
    };
  }

  /** Adapts ordered header fields to Node's duplicate-preserving input shape. */
  #toNodeHeaders(
    fields: TargetRequest["headers"],
  ): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {};
    for (const { name, value } of fields) {
      const current = headers[name];
      headers[name] =
        current === undefined
          ? value
          : Array.isArray(current)
            ? [...current, value]
            : [current, value];
    }
    return headers;
  }

  /** Reconstructs ordered response fields from Node's raw header pairs. */
  #orderedResponseHeaders(
    response: IncomingMessage,
  ): components["schemas"]["HeaderList"] {
    const headers: components["schemas"]["HeaderList"] = [];
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      headers.push({
        name: response.rawHeaders[index] ?? "",
        value: response.rawHeaders[index + 1] ?? "",
      });
    }
    return headers;
  }
}
