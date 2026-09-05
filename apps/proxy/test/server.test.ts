import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { components } from "@apinteract/api-contracts/proxy";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { ProxyConfiguration } from "../src/config.js";
import { createProxyServer } from "../src/transport/server.js";

type CreateExecutionRequest = components["schemas"]["CreateExecutionRequest"];

interface ProblemBody {
  readonly category: string;
  readonly code: string;
}

interface ExecutionBody {
  readonly executionId: string;
}

interface CapabilitiesBody {
  readonly limits: {
    readonly maxConcurrentExecutionsPerPrincipal: number;
    readonly maxRequestBodyBytes: number;
    readonly responseCacheRetentionMs: number;
  };
}

const servers: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("proxy runtime contract", () => {
  it("authenticates before parsing malformed public input", async () => {
    const server = await createServer();
    const response = await server.inject({
      method: "POST",
      url: "/executions",
      headers: {
        "content-type": "application/json",
      },
      payload: '{"unexpected":',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<ProblemBody>()).toMatchObject({
      category: "proxy",
      code: "authentication_required",
    });
  });

  it("reports the same effective limits that execution routes enforce", async () => {
    const server = await createServer({
      maxConcurrentExecutionsPerPrincipal: 2,
      maxRequestBodyBytes: 64,
    });

    const response = await server.inject({
      method: "GET",
      url: "/capabilities",
      headers: authorization(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<CapabilitiesBody>().limits).toMatchObject({
      maxConcurrentExecutionsPerPrincipal: 2,
      maxRequestBodyBytes: 64,
      responseCacheRetentionMs: 50,
    });
  });

  it("uses OpenAPI-derived Fastify schemas for malformed public input", async () => {
    const server = await createServer();
    const malformed = {
      ...descriptor("https://example.com/"),
      unexpected: true,
    };

    const response = await server.inject({
      method: "POST",
      url: "/executions",
      headers: {
        ...authorization(),
        "content-type": "application/json",
        "idempotency-key": "runtime-schema-01",
      },
      payload: malformed,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain(
      "application/problem+json",
    );
    expect(response.json<ProblemBody>()).toMatchObject({
      category: "proxy",
      code: "request_validation_failed",
    });
  });

  it("requires execution behavior fields to be supplied explicitly", async () => {
    const server = await createServer();
    const value = descriptor("https://example.com/");
    delete (value.request.behavior as { connectTimeoutMs?: number })
      .connectTimeoutMs;

    const response = await createExecution(
      server,
      "required-behavior-01",
      value,
    );

    expect(response.statusCode).toBe(400);
    expect(response.json<ProblemBody>().code).toBe("request_validation_failed");
  });

  it("rejects forbidden transport headers through custom OpenAPI semantics", async () => {
    const server = await createServer();
    const value = descriptor("https://example.com/");
    value.request.headers.push({ name: "hOsT", value: "internal.test" });

    const response = await createExecution(server, "forbidden-header", value);

    expect(response.statusCode).toBe(400);
    expect(response.json<ProblemBody>().code).toBe("request_metadata_invalid");
  });

  it("rejects request uploads before buffering past the advertised limit", async () => {
    const server = await createServer({ maxRequestBodyBytes: 3 });
    const creation = await createExecution(
      server,
      "bounded-upload-01",
      descriptor("https://example.com/", true),
    );
    expect(creation.statusCode).toBe(201);

    const response = await server.inject({
      method: "PUT",
      url: `/executions/${creation.json<ExecutionBody>().executionId}/request-body`,
      headers: {
        ...authorization(),
        "content-type": "application/octet-stream",
      },
      payload: Buffer.from("four"),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json<ProblemBody>().code).toBe(
      "request_body_limit_exceeded",
    );
  });

  it("enforces retained execution capacity per authenticated principal", async () => {
    const server = await createServer({
      maxConcurrentExecutionsPerPrincipal: 1,
    });
    const first = await createExecution(
      server,
      "capacity-first-01",
      descriptor("https://example.com/", true),
    );
    const second = await createExecution(
      server,
      "capacity-second-1",
      descriptor("https://example.org/", true),
    );

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(429);
    expect(second.json<ProblemBody>().code).toBe("proxy_capacity_exceeded");
  });

  it("replays concurrent creation for one idempotency key", async () => {
    const server = await createServer({
      maxConcurrentExecutionsPerPrincipal: 1,
    });
    const value = descriptor("https://example.com/", true);

    const [first, replay] = await Promise.all([
      createExecution(server, "concurrent-key-01", value),
      createExecution(server, "concurrent-key-01", value),
    ]);

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(first.json<ExecutionBody>().executionId).toBe(
      replay.json<ExecutionBody>().executionId,
    );
    expect(
      [
        first.headers["idempotency-replayed"],
        replay.headers["idempotency-replayed"],
      ].sort(),
    ).toEqual(["false", "true"]);
  });

  it("rejects a second active response reader", async () => {
    const server = await createServer();
    const creation = await createExecution(
      server,
      "reader-conflict-01",
      descriptor("https://example.com/", true),
    );
    const executionId = creation.json<ExecutionBody>().executionId;
    const first = server.inject({
      method: "GET",
      url: `/executions/${executionId}/response`,
      headers: authorization(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const second = await server.inject({
      method: "GET",
      url: `/executions/${executionId}/response`,
      headers: authorization(),
    });

    expect(second.statusCode).toBe(409);
    expect(second.json<ProblemBody>().code).toBe("execution_state_conflict");
    await server.inject({
      method: "POST",
      url: `/executions/${executionId}/cancel`,
      headers: authorization(),
    });
    await expect(first).resolves.toMatchObject({ statusCode: 200 });
  });

  it("distinguishes an owned expired response from a missing execution", async () => {
    const server = await createServer({}, 250);
    const creation = await createExecution(
      server,
      "expired-response-01",
      descriptor("http://127.0.0.1:65535/"),
    );
    const executionId = creation.json<ExecutionBody>().executionId;
    await server.inject({
      method: "GET",
      url: `/executions/${executionId}/response`,
      headers: authorization(),
    });
    await expect
      .poll(async () => {
        const response = await server.inject({
          method: "GET",
          url: `/executions/${executionId}`,
          headers: authorization(),
        });
        return response.statusCode;
      })
      .toBe(404);

    const expired = await server.inject({
      method: "GET",
      url: `/executions/${executionId}/response`,
      headers: authorization(),
    });
    const missing = await server.inject({
      method: "GET",
      url: "/executions/00000000-0000-7000-8000-000000000000/response",
      headers: authorization(),
    });

    expect(expired.statusCode).toBe(410);
    expect(expired.json<ProblemBody>().code).toBe("execution_expired");
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ProblemBody>().code).toBe("execution_not_found");
  });

  it("returns a terminal policy error without contacting loopback", async () => {
    const server = await createServer();
    const creation = await createExecution(
      server,
      "loopback-policy-1",
      descriptor("http://127.0.0.1:65535/"),
    );
    expect(creation.statusCode).toBe(201);

    const stream = await server.inject({
      method: "GET",
      url: `/executions/${creation.json<ExecutionBody>().executionId}/response`,
      headers: authorization(),
    });
    const frame = stream.rawPayload;
    const payloadLength = Number(frame.readBigUInt64BE(8));
    const error: unknown = JSON.parse(
      frame.subarray(16, 16 + payloadLength).toString("utf8"),
    );

    expect(stream.statusCode).toBe(200);
    expect(frame.readUInt8(0)).toBe(5);
    expect(error).toMatchObject({
      category: "proxy",
      code: "target_policy_denied",
      phase: "dns",
    });
  });
});

/** Creates one isolated in-memory Fastify proxy with a writable frame cache. */
async function createServer(
  limitOverrides: Partial<ProxyConfiguration["limits"]> = {},
  retentionMs = 50,
): Promise<FastifyInstance> {
  const cachePath = await mkdtemp(join(tmpdir(), "apinteract-proxy-server-"));
  temporaryDirectories.push(cachePath);
  const configuration: ProxyConfiguration = {
    configVersion: 1,
    server: { host: "127.0.0.1", port: 8081 },
    cache: { path: cachePath, retentionMs },
    limits: {
      maxMetadataBytes: 1_024,
      maxRequestHeaderCount: 8,
      maxRequestBodyBytes: 128,
      maxResponseBodyBytes: 4_096,
      maxCacheBytesPerPrincipal: 32_768,
      maxConcurrentExecutionsPerPrincipal: 4,
      ...limitOverrides,
    },
    targetPolicy: {
      privateNetworkAccess: "deny",
      allowCidrs: [],
      denyCidrs: [],
    },
    principals: [{ id: "backend", bearerToken: "test-token" }],
  };
  const server = createProxyServer(configuration);
  servers.push(server);
  await server.ready();
  return server;
}

/** Creates one valid proxy execution through the authenticated public route. */
function createExecution(
  server: FastifyInstance,
  idempotencyKey: string,
  value: CreateExecutionRequest,
) {
  return server.inject({
    method: "POST",
    url: "/executions",
    headers: {
      ...authorization(),
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    payload: value,
  });
}

/** Returns the bearer header for the configured test principal. */
function authorization(): Record<string, string> {
  return { authorization: "Bearer test-token" };
}

/** Builds one schema-valid execution descriptor for route tests. */
function descriptor(url: string, body = false): CreateExecutionRequest {
  return {
    request: {
      method: body ? "POST" : "GET",
      url,
      headers: [],
      body: body
        ? { mode: "stream", length: null, sha256: null }
        : { mode: "none", length: 0, sha256: null },
      behavior: {
        connectTimeoutMs: 1_000,
        responseHeaderTimeoutMs: 1_000,
        responseIdleTimeoutMs: 1_000,
        totalTimeoutMs: 5_000,
        redirectMode: "manual",
        tlsVerification: "strict",
        maxResponseBodyBytes: 4_096,
      },
    },
  };
}
