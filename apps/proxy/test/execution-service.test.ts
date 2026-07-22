import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { components } from "@apinteract/api-contracts/proxy";
import { afterEach, describe, expect, it } from "vitest";

import { ExecutionService } from "../src/application/execution-service.js";
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
    targetServers.splice(0).map(
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
    targetServers.push(targetServer);
    await new Promise<void>((resolve, reject) => {
      targetServer.once("error", reject);
      targetServer.listen(0, "127.0.0.1", resolve);
    });
    const address = targetServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Target server did not bind to an IP socket");
    }

    const directory = await mkdtemp(
      join(tmpdir(), "apinteract-execution-test-"),
    );
    temporaryDirectories.push(directory);
    const executions = new ExecutionService(directory, 60_000);
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
  const stream = executions.stream(principalId, session.executionId, -1);
  if (stream === undefined) {
    throw new Error("Created execution was not available");
  }
  for await (const frame of stream) {
    // Reading through the terminal frame applies the target request lifecycle.
    expect(frame.byteLength).toBeGreaterThan(0);
  }
  await expect
    .poll(() => executions.get(principalId, session.executionId)?.state)
    .toBe("completed");
  await executions.release(principalId, session.executionId);
}
