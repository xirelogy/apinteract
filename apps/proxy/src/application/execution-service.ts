import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

import type { components } from "@apinteract/api-contracts/proxy";
import { v7 as uuidV7 } from "uuid";

import {
  FrameStore,
  FrameType,
  MAX_FRAME_PAYLOAD_BYTES,
} from "../protocol/frame-store.js";
import { DEFAULT_PROXY_USER_AGENT } from "../version.js";

type CreateExecutionRequest = components["schemas"]["CreateExecutionRequest"];
type ExecutionSession = components["schemas"]["ExecutionSession"];
type TargetRequest = components["schemas"]["TargetRequest"];
type ExecutionStreamError = components["schemas"]["ExecutionStreamError"];

interface ManagedExecution {
  readonly id: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly descriptorHash: string;
  readonly createdAt: string;
  readonly frameStore: FrameStore;
  state: ExecutionSession["state"];
  requestBodyState: ExecutionSession["requestBodyState"];
  responseState: ExecutionSession["responseState"];
  error: ExecutionStreamError | null;
  expiresAt: string | null;
  request?: ReturnType<typeof httpRequest>;
  target: TargetRequest;
}

/** Raised when one principal reuses an idempotency key for different input. */
export class IdempotencyConflictError extends Error {}

/** Raised when a request body upload conflicts with execution state or metadata. */
export class RequestBodyUploadError extends Error {}

/**
 * Owns transient target executions and their replayable response frames.
 *
 * Every lookup is scoped to the authenticated backend principal. Execution
 * state is intentionally in-memory for the MVP; only frame bytes are cached on
 * disk. Explicit release discards both, while terminal state records the
 * configured expiry deadline.
 */
export class ExecutionService {
  readonly #cachePath: string;
  readonly #retentionMs: number;
  readonly #executions = new Map<string, ManagedExecution>();
  readonly #idempotency = new Map<string, string>();

  constructor(cachePath: string, retentionMs: number) {
    this.#cachePath = cachePath;
    this.#retentionMs = retentionMs;
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

    const id = uuidV7();
    const execution: ManagedExecution = {
      id,
      principalId,
      idempotencyKey,
      descriptorHash,
      createdAt: new Date().toISOString(),
      frameStore: await FrameStore.create(
        join(this.#cachePath, `${id}.frames`),
      ),
      state: descriptor.request.body.mode === "none" ? "active" : "accepted",
      requestBodyState:
        descriptor.request.body.mode === "none"
          ? "not_required"
          : "awaiting_upload",
      responseState: "waiting",
      error: null,
      expiresAt: null,
      target: descriptor.request,
    };
    this.#executions.set(id, execution);
    this.#idempotency.set(key, id);
    // Creation returns as soon as the replay state exists. Target I/O continues
    // independently and is observed through the response data plane.
    if (descriptor.request.body.mode === "none") {
      void this.#run(execution, Buffer.alloc(0));
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
    void this.#run(execution, body);
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
  ): AsyncGenerator<Buffer> | undefined {
    return this.#owned(principalId, executionId)?.frameStore.readAfter(
      afterSequence,
    );
  }

  /** Requests best-effort cancellation of an owned active execution. */
  cancel(
    principalId: string,
    executionId: string,
  ): ExecutionSession | undefined {
    const execution = this.#owned(principalId, executionId);
    if (execution === undefined) {
      return undefined;
    }
    if (execution.state === "active") {
      // Cancellation is best effort: the target may already have processed
      // bytes before the underlying request is destroyed.
      execution.request?.destroy(new Error("Execution cancelled"));
      execution.state = "cancelled";
      execution.responseState = "cancelled";
      execution.expiresAt = this.#expiresAt();
    }
    return this.#toSession(execution);
  }

  /** Releases terminal execution state, frames, and idempotency mapping. */
  async release(principalId: string, executionId: string): Promise<boolean> {
    const execution = this.#owned(principalId, executionId);
    if (execution === undefined) {
      return false;
    }
    if (execution.state === "active") {
      throw new Error("Execution is not terminal");
    }
    // Releasing also ends idempotent replay for this key. A later use creates a
    // new execution, as defined by the proxy API lifecycle.
    this.#executions.delete(execution.id);
    this.#idempotency.delete(
      `${execution.principalId}:${execution.idempotencyKey}`,
    );
    await execution.frameStore.dispose();
    return true;
  }

  /** Performs target HTTP I/O and records its terminal framed response. */
  async #run(execution: ManagedExecution, requestBody: Buffer): Promise<void> {
    try {
      const target = execution.target;
      const url = new URL(target.url);
      const headers = this.#toNodeHeaders(target.headers);
      if (
        !target.headers.some(({ name }) => name.toLowerCase() === "user-agent")
      ) {
        headers["User-Agent"] = DEFAULT_PROXY_USER_AGENT;
      }
      if (target.body.mode === "stream" && target.body.length !== null) {
        // Content-Length is transport-owned and derived only from the validated
        // descriptor, never from a user-supplied header field.
        headers["Content-Length"] = String(target.body.length);
      }
      const requestFunction =
        url.protocol === "https:" ? httpsRequest : httpRequest;

      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = requestFunction(
          url,
          {
            method: target.method,
            headers,
            rejectUnauthorized: target.behavior.tlsVerification === "strict",
            signal: AbortSignal.timeout(target.behavior.totalTimeoutMs),
          },
          resolve,
        );
        execution.request = request;
        request.once("error", reject);
        request.end(requestBody);
      });

      execution.responseState = "streaming";
      // A target HTTP status, including 4xx or 5xx, is response metadata and
      // does not represent a proxy or network failure.
      await execution.frameStore.appendJson(FrameType.ResponseHead, {
        status: response.statusCode ?? 500,
        reasonPhrase: response.statusMessage ?? null,
        httpVersion: "HTTP/1.1",
        headers: this.#orderedResponseHeaders(response),
        receivedAt: new Date().toISOString(),
      });

      const digest = createHash("sha256");
      let bodyBytes = 0;
      for await (const chunk of response as AsyncIterable<Uint8Array>) {
        const bytes = Buffer.from(chunk);
        bodyBytes += bytes.byteLength;
        if (bodyBytes > target.behavior.maxResponseBodyBytes) {
          throw new Error("Target response exceeded maxResponseBodyBytes");
        }
        digest.update(bytes);
        // Node stream chunks are not protocol frames. Split them at the wire
        // limit while preserving the target body's exact byte sequence.
        for (
          let offset = 0;
          offset < bytes.byteLength;
          offset += MAX_FRAME_PAYLOAD_BYTES
        ) {
          await execution.frameStore.append(
            FrameType.Body,
            bytes.subarray(offset, offset + MAX_FRAME_PAYLOAD_BYTES),
          );
        }
      }

      await execution.frameStore.appendJson(
        FrameType.Complete,
        {
          bodyBytes,
          bodySha256: digest.digest("hex"),
          timings: {},
          completedAt: new Date().toISOString(),
        },
        true,
      );
      execution.state = "completed";
      execution.responseState = "complete";
      execution.expiresAt = this.#expiresAt();
    } catch (cause) {
      if (execution.state === "cancelled") {
        if (!execution.frameStore.terminal) {
          await this.#appendError(execution, "execution_cancelled", "proxy");
        }
        return;
      }
      const message =
        cause instanceof Error
          ? cause.message
          : "Unknown target execution error";
      execution.error = {
        category: message.includes("not implemented") ? "proxy" : "network",
        code: message.includes("maxResponseBodyBytes")
          ? "response_body_too_large"
          : "target_request_failed",
        message,
        phase: execution.responseState === "streaming" ? "response" : "connect",
        retryable: false,
      };
      execution.state = "failed";
      execution.responseState = "failed";
      execution.expiresAt = this.#expiresAt();
      if (!execution.frameStore.terminal) {
        await execution.frameStore.appendJson(
          FrameType.Error,
          execution.error,
          true,
        );
      }
    }
  }

  /** Appends the terminal cancellation error frame and stores its metadata. */
  async #appendError(
    execution: ManagedExecution,
    code: string,
    category: ExecutionStreamError["category"],
  ): Promise<void> {
    execution.error = {
      category,
      code,
      message: "The execution was cancelled.",
      phase: "internal",
      retryable: false,
    };
    await execution.frameStore.appendJson(
      FrameType.Error,
      execution.error,
      true,
    );
  }

  /** Resolves an execution only when its immutable principal owner matches. */
  #owned(
    principalId: string,
    executionId: string,
  ): ManagedExecution | undefined {
    const execution = this.#executions.get(executionId);
    // Returning the same absence for missing and foreign executions prevents a
    // principal from probing another principal's transient identifiers.
    return execution?.principalId === principalId ? execution : undefined;
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

  /** Calculates the transient-state retention deadline. */
  #expiresAt(): string {
    return new Date(Date.now() + this.#retentionMs).toISOString();
  }

  /** Adapts ordered header fields to Node's duplicate-preserving input shape. */
  #toNodeHeaders(
    fields: TargetRequest["headers"],
  ): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {};
    for (const { name, value } of fields) {
      // Arrays preserve repeated field values when adapting the ordered API
      // representation to Node's HTTP client.
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
    // rawHeaders is required here because IncomingMessage.headers combines
    // fields and loses the original ordering and spelling.
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      headers.push({
        name: response.rawHeaders[index] ?? "",
        value: response.rawHeaders[index + 1] ?? "",
      });
    }
    return headers;
  }
}
