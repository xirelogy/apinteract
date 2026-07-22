import { createHash } from "node:crypto";

import type { components } from "@apinteract/api-contracts/proxy";

type HeaderField = components["schemas"]["HeaderField"];
type TargetRequest = components["schemas"]["TargetRequest"];
type ResponseHead = components["schemas"]["ResponseHead"];
type ResponseComplete = components["schemas"]["ResponseComplete"];
type StreamError = components["schemas"]["ExecutionStreamError"];

const FRAME_HEADER_BYTES = 16;
const MAX_FRAME_PAYLOAD_BYTES = 1_048_576;

const FrameType = {
  ResponseHead: 1,
  Body: 2,
  Trailers: 3,
  Complete: 4,
  Error: 5,
  Heartbeat: 6,
} as const;

type FrameType = (typeof FrameType)[keyof typeof FrameType];

/**
 * Receives one decoded proxy response stream in wire order.
 *
 * Each callback is awaited before another frame is dispatched, allowing blob
 * persistence and event publication to exert backpressure on network reads.
 */
export interface ProxyResponseSink {
  responseHead(value: ResponseHead): Promise<void>;
  body(bytes: Buffer): Promise<void>;
  complete(value: ResponseComplete): Promise<void>;
}

/** A terminal execution failure reported by the proxy data plane. */
export class ProxyExecutionError extends Error {
  readonly detail: StreamError;

  constructor(detail: StreamError) {
    super(detail.message);
    this.detail = detail;
  }
}

/**
 * Adapter from backend request orchestration to the public proxy API.
 *
 * The client creates an execution on the control plane, consumes its framed
 * response on the data plane, and releases terminal proxy state afterward.
 */
export class ProxyClient {
  readonly #endpoint: string;
  readonly #bearerToken: string;

  constructor(endpoint: string, bearerToken: string) {
    this.#endpoint = endpoint.replace(/\/$/, "");
    this.#bearerToken = bearerToken;
  }

  /** Reports whether the configured proxy health endpoint is reachable and ready. */
  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.#endpoint}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Executes one HTTP request and streams decoded response frames to the sink. */
  async execute(
    idempotencyKey: string,
    method: string,
    url: string,
    headers: readonly HeaderField[],
    body: Buffer,
    sink: ProxyResponseSink,
  ): Promise<void> {
    const bodyDescriptor: TargetRequest["body"] =
      body.byteLength === 0
        ? { mode: "none", length: 0, sha256: null }
        : {
            mode: "stream",
            length: body.byteLength,
            sha256: createHash("sha256").update(body).digest("hex"),
          };
    const creation = await fetch(`${this.#endpoint}/executions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#bearerToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        request: {
          method,
          url,
          headers,
          body: bodyDescriptor,
          behavior: {
            connectTimeoutMs: 10_000,
            responseHeaderTimeoutMs: 30_000,
            responseIdleTimeoutMs: 30_000,
            totalTimeoutMs: 300_000,
            redirectMode: "manual",
            tlsVerification: "strict",
            maxResponseBodyBytes: 1_073_741_824,
          },
        },
      }),
    });
    if (!creation.ok) {
      throw new Error(
        `Proxy rejected execution creation with ${creation.status}`,
      );
    }
    const session = (await creation.json()) as {
      readonly executionId: string;
    };

    try {
      if (body.byteLength > 0) {
        const upload = await fetch(
          `${this.#endpoint}/executions/${session.executionId}/request-body`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${this.#bearerToken}`,
              "Content-Type": "application/octet-stream",
            },
            body: body.toString("utf8"),
          },
        );
        if (!upload.ok) {
          throw new Error(`Proxy rejected request body with ${upload.status}`);
        }
      }
      const response = await fetch(
        `${this.#endpoint}/executions/${session.executionId}/response`,
        {
          headers: {
            Authorization: `Bearer ${this.#bearerToken}`,
          },
        },
      );
      if (!response.ok || response.body === null) {
        throw new Error(`Proxy response stream failed with ${response.status}`);
      }
      await this.#consumeFrames(response.body, sink);
    } finally {
      // Release is cleanup, so its failure must not replace the execution or
      // stream error already being returned to the backend.
      await fetch(`${this.#endpoint}/executions/${session.executionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.#bearerToken}` },
      }).catch(() => undefined);
    }
  }

  /** Buffers arbitrary fetch chunks into validated complete protocol frames. */
  async #consumeFrames(
    body: ReadableStream<Uint8Array>,
    sink: ProxyResponseSink,
  ): Promise<void> {
    // Fetch chunks have no relationship to protocol-frame boundaries. Retain
    // incomplete bytes until one complete frame can be validated and decoded.
    let buffered = Buffer.alloc(0);
    let expectedSequence = 0;
    let terminal = false;
    const reader = body.getReader();
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const chunk = result.value;
      buffered = Buffer.concat([
        buffered,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      while (buffered.byteLength >= FRAME_HEADER_BYTES) {
        const payloadLength = Number(buffered.readBigUInt64BE(8));
        if (
          !Number.isSafeInteger(payloadLength) ||
          payloadLength > MAX_FRAME_PAYLOAD_BYTES
        ) {
          throw new Error("Proxy frame payload length is invalid");
        }
        const frameLength = FRAME_HEADER_BYTES + payloadLength;
        if (buffered.byteLength < frameLength) {
          break;
        }
        const type = parseFrameType(buffered.readUInt8(0));
        const flags = buffered.readUInt8(1);
        const reserved = buffered.readUInt16BE(2);
        const sequence = buffered.readUInt32BE(4);
        if (flags !== 0 || reserved !== 0 || sequence !== expectedSequence) {
          throw new Error("Proxy frame header is invalid");
        }
        expectedSequence += 1;
        const payload = buffered.subarray(FRAME_HEADER_BYTES, frameLength);
        buffered = buffered.subarray(frameLength);
        terminal = await this.#dispatchFrame(type, payload, sink);
        if (terminal && buffered.byteLength !== 0) {
          throw new Error("Proxy sent bytes after a terminal frame");
        }
      }
    }
    if (!terminal || buffered.byteLength !== 0) {
      throw new Error("Proxy stream ended before a complete terminal frame");
    }
  }

  /** Dispatches one validated frame while preserving sink backpressure. */
  async #dispatchFrame(
    type: FrameType,
    payload: Buffer,
    sink: ProxyResponseSink,
  ): Promise<boolean> {
    if (type === FrameType.ResponseHead) {
      await sink.responseHead(
        JSON.parse(payload.toString("utf8")) as ResponseHead,
      );
      return false;
    }
    if (type === FrameType.Body) {
      await sink.body(payload);
      return false;
    }
    if (type === FrameType.Complete) {
      await sink.complete(
        JSON.parse(payload.toString("utf8")) as ResponseComplete,
      );
      return true;
    }
    if (type === FrameType.Error) {
      throw new ProxyExecutionError(
        JSON.parse(payload.toString("utf8")) as StreamError,
      );
    }
    if (type === FrameType.Trailers || type === FrameType.Heartbeat) {
      return false;
    }
    throw new Error("Validated proxy frame type was not dispatched");
  }
}

/** Validates an untrusted wire byte as a supported response frame type. */
function parseFrameType(value: number): FrameType {
  switch (value) {
    case FrameType.ResponseHead:
    case FrameType.Body:
    case FrameType.Trailers:
    case FrameType.Complete:
    case FrameType.Error:
    case FrameType.Heartbeat:
      return value;
    default:
      throw new Error(`Unknown proxy frame type ${value}`);
  }
}
