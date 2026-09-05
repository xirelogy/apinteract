import { mkdtemp, rm, stat } from "node:fs/promises";
import { lookup } from "node:dns";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { components } from "@apinteract/api-contracts/proxy";
import { afterEach, describe, expect, it } from "vitest";

import {
  ExecutionExpiredError,
  ExecutionResponseReaderConflictError,
  ExecutionService,
  IdempotencyConflictError,
  PrincipalCapacityError,
} from "../src/application/execution-service.js";
import type { TargetApprover } from "../src/application/target-policy.js";
import {
  DEFAULT_PROXY_LIMITS,
  type ProxyLimitsConfiguration,
} from "../src/config.js";
import {
  DEFAULT_PROXY_USER_AGENT,
  PROXY_APPLICATION_VERSION,
} from "../src/version.js";

type CreateExecutionRequest = components["schemas"]["CreateExecutionRequest"];
type HeaderList = components["schemas"]["HeaderList"];

const temporaryDirectories: string[] = [];
const targetServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    targetServers
      .splice(0)
      .filter((server) => server.listening)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((cause) =>
              cause === undefined ? resolve() : reject(cause),
            );
          }),
      ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ExecutionService outbound headers", () => {
  it("defaults User-Agent while preserving a caller-supplied value", async () => {
    const receivedUserAgents: (string | undefined)[] = [];
    const targetServer = createServer((request, response) => {
      receivedUserAgents.push(request.headers["user-agent"]);
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      targetServer.once("error", reject);
      targetServer.listen(0, "127.0.0.1", resolve);
    });
    targetServers.push(targetServer);
    const address = targetServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Target server did not bind to an IP socket");
    }

    const directory = await mkdtemp(
      join(tmpdir(), "apinteract-execution-test-"),
    );
    temporaryDirectories.push(directory);
    const executions = new ExecutionService({
      cachePath: directory,
      retentionMs: 60_000,
      limits: DEFAULT_PROXY_LIMITS,
      // This transport-focused test injects its loopback fixture directly; the
      // production TargetPolicy always rejects loopback before socket creation.
      targetPolicy: { approve: () => Promise.resolve({ lookup }) },
    });
    const targetUrl = `http://127.0.0.1:${address.port}/`;

    await executeAndRelease(
      executions,
      "principal",
      "default-user-agent",
      createDescriptor(targetUrl, []),
    );
    await executeAndRelease(
      executions,
      "principal",
      "explicit-user-agent",
      createDescriptor(targetUrl, [
        { name: "uSeR-aGeNt", value: "custom-client/1.2.3" },
      ]),
    );

    expect(receivedUserAgents).toEqual([
      `apinteract-proxy/${PROXY_APPLICATION_VERSION}`,
      "custom-client/1.2.3",
    ]);
    expect(DEFAULT_PROXY_USER_AGENT).toBe(receivedUserAgents[0]);
  });
});

describe("ExecutionService limits and lifecycle", () => {
  it("serializes creation by principal and idempotency key", async () => {
    const directory = await temporaryDirectory();
    const executions = executionService(directory, {
      maxConcurrentExecutionsPerPrincipal: 2,
    });
    const value = createDescriptor("https://example.com/", []);
    value.request.body = { mode: "stream", length: null, sha256: null };

    const [first, replay] = await Promise.all([
      executions.create("principal", "shared-key", value),
      executions.create("principal", "shared-key", value),
    ]);

    expect(first.session.executionId).toBe(replay.session.executionId);
    expect([first.replayed, replay.replayed].sort()).toEqual([false, true]);

    const different = createDescriptor("https://different.example/", []);
    different.request.body = { mode: "stream", length: null, sha256: null };
    await expect(
      executions.create("principal", "shared-key", different),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const pending = executions.create("second-principal", "pending-key", value);
    await expect(
      executions.create("second-principal", "pending-key", different),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(pending).resolves.toMatchObject({ replayed: false });

    await expect(
      executions.create("principal", "unrelated-key", value),
    ).resolves.toMatchObject({ replayed: false });
    await expect(
      executions.create("principal", "capacity-key", value),
    ).rejects.toBeInstanceOf(PrincipalCapacityError);
    await executions.close();
  });

  it("leases one response reader and releases it explicitly", async () => {
    const directory = await temporaryDirectory();
    const executions = executionService(directory);
    const value = createDescriptor("https://example.com/", []);
    value.request.body = { mode: "stream", length: null, sha256: null };
    const { session } = await executions.create(
      "principal",
      "reader-lease-key",
      value,
    );

    const first = executions.stream("principal", session.executionId, -1);
    expect(first).toBeDefined();
    expect(() =>
      executions.stream("principal", session.executionId, -1),
    ).toThrow(ExecutionResponseReaderConflictError);

    first?.close();
    const resumed = executions.stream("principal", session.executionId, -1);
    expect(resumed).toBeDefined();
    resumed?.close();
    await executions.cancel("principal", session.executionId);
    await executions.release("principal", session.executionId);
    expect(
      executions.stream("principal", session.executionId, -1),
    ).toBeUndefined();
    await executions.close();
  });

  it("applies total timeout while an execution is awaiting body upload", async () => {
    const directory = await temporaryDirectory();
    const executions = executionService(directory, {}, 60_000);
    const value = createDescriptor("https://example.com/", []);
    value.request.body = { mode: "stream", length: null, sha256: null };
    value.request.behavior.totalTimeoutMs = 20;

    const { session } = await executions.create(
      "principal",
      "waiting-upload-timeout",
      value,
    );
    const error = await readTerminalError(executions, session.executionId);

    expect(error).toMatchObject({ code: "total_timeout", phase: "upload" });
    expect(executions.get("principal", session.executionId)?.state).toBe(
      "failed",
    );
    await executions.release("principal", session.executionId);
  });

  it("enforces connection, response-head, and response-idle timeouts", async () => {
    const directory = await temporaryDirectory();
    /** Simulates a resolver that never completes before the connection timer. */
    const neverLookup: LookupFunction = () => undefined;
    const connectExecutions = executionService(directory, {}, 60_000, {
      approve: () => Promise.resolve({ lookup: neverLookup }),
    });
    const connectDescriptor = createDescriptor("http://unresolved.test/", []);
    connectDescriptor.request.behavior.connectTimeoutMs = 20;
    const connect = await connectExecutions.create(
      "principal-connect",
      "connect-timeout-key",
      connectDescriptor,
    );
    await expect(
      readTerminalError(
        connectExecutions,
        connect.session.executionId,
        "principal-connect",
      ),
    ).resolves.toMatchObject({ code: "connect_timeout" });

    const headerServer = await listenTarget(() => undefined);
    const headerExecutions = executionService(directory);
    const headerDescriptor = createDescriptor(targetUrl(headerServer), []);
    headerDescriptor.request.behavior.responseHeaderTimeoutMs = 20;
    const header = await headerExecutions.create(
      "principal-header",
      "header-timeout-key",
      headerDescriptor,
    );
    await expect(
      readTerminalError(
        headerExecutions,
        header.session.executionId,
        "principal-header",
      ),
    ).resolves.toMatchObject({ code: "response_header_timeout" });

    const idleServer = await listenTarget((_request, response) => {
      response.writeHead(200);
      response.write("partial");
    });
    const idleExecutions = executionService(directory);
    const idleDescriptor = createDescriptor(targetUrl(idleServer), []);
    idleDescriptor.request.behavior.responseIdleTimeoutMs = 20;
    const idle = await idleExecutions.create(
      "principal-idle",
      "idle-timeout-key-1",
      idleDescriptor,
    );
    await expect(
      readTerminalError(
        idleExecutions,
        idle.session.executionId,
        "principal-idle",
      ),
    ).resolves.toMatchObject({ code: "response_idle_timeout" });

    await Promise.all([
      connectExecutions.close(),
      headerExecutions.close(),
      idleExecutions.close(),
    ]);
  });

  it("caps response bytes and the aggregate principal frame cache", async () => {
    const directory = await temporaryDirectory();
    const targetServer = await listenTarget((_request, response) => {
      response.end(Buffer.alloc(6_000, 7));
    });

    const responseExecutions = executionService(directory, {
      maxResponseBodyBytes: 10_000,
    });
    const responseDescriptor = createDescriptor(targetUrl(targetServer), []);
    responseDescriptor.request.behavior.maxResponseBodyBytes = 5;
    const response = await responseExecutions.create(
      "principal-response",
      "response-limit-key",
      responseDescriptor,
    );
    await expect(
      readTerminalError(
        responseExecutions,
        response.session.executionId,
        "principal-response",
      ),
    ).resolves.toMatchObject({ code: "response_body_limit_exceeded" });

    const cacheExecutions = executionService(directory, {
      maxResponseBodyBytes: 10_000,
      maxCacheBytesPerPrincipal: 5_000,
    });
    const cacheDescriptor = createDescriptor(targetUrl(targetServer), []);
    cacheDescriptor.request.behavior.maxResponseBodyBytes = 10_000;
    const cache = await cacheExecutions.create(
      "principal-cache",
      "cache-limit-key-01",
      cacheDescriptor,
    );
    await expect(
      readTerminalError(
        cacheExecutions,
        cache.session.executionId,
        "principal-cache",
      ),
    ).resolves.toMatchObject({ code: "proxy_capacity_exceeded" });

    await Promise.all([responseExecutions.close(), cacheExecutions.close()]);
  });

  it("removes terminal state, cache files, and quota reservations at expiry", async () => {
    const directory = await temporaryDirectory();
    const executions = executionService(directory, {}, 100);
    const value = createDescriptor("https://example.com/", []);
    value.request.body = { mode: "stream", length: null, sha256: null };
    value.request.behavior.totalTimeoutMs = 10;
    const { session } = await executions.create(
      "principal",
      "expiry-cleanup-key",
      value,
    );
    await readTerminalError(executions, session.executionId);

    await expect
      .poll(() => executions.get("principal", session.executionId))
      .toBeUndefined();
    expect(() =>
      executions.stream("principal", session.executionId, -1),
    ).toThrow(ExecutionExpiredError);
    expect(
      executions.stream("foreign-principal", session.executionId, -1),
    ).toBeUndefined();
    await expect(
      stat(join(directory, `${session.executionId}.frames`)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const replacement = await executions.create(
      "principal",
      "replacement-key-1",
      value,
    );
    expect(replacement.replayed).toBe(false);
    await executions.close();
  });
});

/** Builds a bodyless target descriptor with deterministic execution limits. */
function createDescriptor(
  url: string,
  headers: HeaderList,
): CreateExecutionRequest {
  return {
    request: {
      method: "GET",
      url,
      headers,
      body: { mode: "none", length: 0, sha256: null },
      behavior: {
        connectTimeoutMs: 1_000,
        responseHeaderTimeoutMs: 1_000,
        responseIdleTimeoutMs: 1_000,
        totalTimeoutMs: 5_000,
        redirectMode: "manual",
        tlsVerification: "strict",
        maxResponseBodyBytes: 1_024,
      },
    },
  };
}

/** Waits for one execution's terminal stream and releases its frame cache. */
async function executeAndRelease(
  executions: ExecutionService,
  principalId: string,
  idempotencyKey: string,
  descriptor: CreateExecutionRequest,
): Promise<void> {
  const { session } = await executions.create(
    principalId,
    idempotencyKey,
    descriptor,
  );
  const reader = executions.stream(principalId, session.executionId, -1);
  if (reader === undefined) {
    throw new Error("Created execution was not available");
  }
  for await (const frame of reader.frames) {
    // Reading through the terminal frame applies the target request lifecycle.
    expect(frame.byteLength).toBeGreaterThan(0);
  }
  await expect
    .poll(() => {
      const current = executions.get(principalId, session.executionId);
      return current?.state === "active" || current?.state === "accepted"
        ? undefined
        : current;
    })
    .toBeDefined();
  expect(executions.get(principalId, session.executionId)).toMatchObject({
    state: "completed",
    responseState: "complete",
    error: null,
  });
  await executions.release(principalId, session.executionId);
}

/** Creates and tracks one temporary proxy cache directory. */
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "apinteract-execution-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** Creates an execution service with deterministic test target approval. */
function executionService(
  cachePath: string,
  limitOverrides: Partial<ProxyLimitsConfiguration> = {},
  retentionMs = 60_000,
  targetPolicy: TargetApprover = {
    approve: () => Promise.resolve({ lookup }),
  },
): ExecutionService {
  return new ExecutionService({
    cachePath,
    retentionMs,
    limits: { ...DEFAULT_PROXY_LIMITS, ...limitOverrides },
    targetPolicy,
  });
}

/** Starts and tracks one deterministic local target server. */
async function listenTarget(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Server> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  targetServers.push(server);
  return server;
}

/** Returns the loopback URL of one listening target fixture. */
function targetUrl(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Target server did not bind to an IP socket");
  }
  return `http://127.0.0.1:${address.port}/`;
}

/** Reads an execution stream through its terminal JSON error frame. */
async function readTerminalError(
  executions: ExecutionService,
  executionId: string,
  principalId = "principal",
): Promise<Record<string, unknown>> {
  const reader = executions.stream(principalId, executionId, -1);
  if (reader === undefined) {
    throw new Error("Created execution was not available");
  }
  for await (const frame of reader.frames) {
    if (frame.readUInt8(0) === 5) {
      const payloadLength = Number(frame.readBigUInt64BE(8));
      return JSON.parse(
        frame.subarray(16, 16 + payloadLength).toString("utf8"),
      ) as Record<string, unknown>;
    }
  }
  throw new Error("Execution did not produce a terminal error frame");
}
