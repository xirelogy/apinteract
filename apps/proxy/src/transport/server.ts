import { timingSafeEqual } from "node:crypto";

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { components } from "@apinteract/api-contracts/proxy";

import type { ProxyConfiguration } from "../config.js";
import {
  ExecutionService,
  IdempotencyConflictError,
  RequestBodyUploadError,
} from "../application/execution-service.js";
import { PROXY_APPLICATION_VERSION } from "../version.js";

type CreateExecutionRequest = components["schemas"]["CreateExecutionRequest"];

interface AuthenticatedRequest extends FastifyRequest {
  principalId: string;
}

/** Resolves a bearer credential to its configured stable backend principal. */
function authenticate(
  configuration: ProxyConfiguration,
  request: FastifyRequest,
): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }
  const supplied = Buffer.from(authorization.slice(7));
  for (const principal of configuration.principals) {
    const expected = Buffer.from(principal.bearerToken);
    // timingSafeEqual requires equal-length inputs; compare length first while
    // avoiding an ordinary byte-by-byte secret comparison.
    if (
      supplied.byteLength === expected.byteLength &&
      timingSafeEqual(supplied, expected)
    ) {
      return principal.id;
    }
  }
  return undefined;
}

/** Sends a proxy problem response with stable status and error code. */
function problem(
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
): FastifyReply {
  return reply
    .code(status)
    .type("application/problem+json")
    .send({
      type: `/problems/${code}`,
      title:
        status === 401 ? "Authentication required" : "Proxy request failed",
      status,
      code,
      detail,
    });
}

/**
 * Creates the public proxy control-plane and response-stream server.
 *
 * Authentication resolves a configured bearer token to a stable backend
 * principal. Routes pass only that derived principal to ExecutionService;
 * execution ownership is never accepted from request data.
 */
export function createProxyServer(
  configuration: ProxyConfiguration,
): FastifyInstance {
  const server = Fastify({ logger: true });
  const executions = new ExecutionService(
    configuration.cache.path,
    configuration.cache.retentionMs,
  );
  server.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  /** Reports unauthenticated proxy process readiness and API version. */
  server.get("/health", () => ({
    status: "ready",
    apiVersion: "0.1.1",
    componentVersion: PROXY_APPLICATION_VERSION,
  }));

  server.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health") {
      return;
    }
    const principalId = authenticate(configuration, request);
    if (principalId === undefined) {
      return problem(
        reply,
        401,
        "authentication_required",
        "A recognized bearer token is required.",
      );
    }
    // The authenticated principal is server-derived request context and cannot
    // be supplied or replaced by a route body or path parameter.
    (request as AuthenticatedRequest).principalId = principalId;
  });

  /** Reports authenticated protocol features and effective principal limits. */
  server.get("/capabilities", () => ({
    apiVersion: "0.1.1",
    responseFrameVersions: [1],
    outboundHttpVersions: ["HTTP/1.1"],
    features: {
      responseResume: true,
      requestUploadResume: false,
      redirectModes: ["manual"],
      tlsVerificationModes: ["strict", "insecure"],
      transportMetadata: {
        remoteEndpoint: false,
        localEndpoint: false,
        connectionReuse: false,
        tlsSummary: false,
        peerCertificateChain: false,
      },
      automaticContentDecompression: false,
      cookieJar: false,
    },
    limits: {
      maxMetadataBytes: 1_048_576,
      maxRequestHeaderCount: 1024,
      maxRequestBodyBytes: 786_432,
      maxResponseBodyBytes: 1_073_741_824,
      maxCacheBytesPerPrincipal: 2_147_483_648,
      maxConcurrentExecutionsPerPrincipal: 16,
      responseCacheRetentionMs: configuration.cache.retentionMs,
      maxFramePayloadBytes: 1_048_576,
    },
  }));

  /** Creates or replays a principal-scoped idempotent target execution. */
  server.post<{ Body: CreateExecutionRequest }>(
    "/executions",
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
        return problem(
          reply,
          400,
          "idempotency_key_required",
          "Idempotency-Key is required.",
        );
      }
      try {
        const result = await executions.create(
          (request as AuthenticatedRequest).principalId,
          idempotencyKey,
          request.body,
        );
        return reply
          .code(201)
          .header("Location", `/executions/${result.session.executionId}`)
          .header("Idempotency-Replayed", result.replayed)
          .send(result.session);
      } catch (cause) {
        if (cause instanceof IdempotencyConflictError) {
          return problem(reply, 409, "idempotency_conflict", cause.message);
        }
        throw cause;
      }
    },
  );

  /** Accepts one complete raw body for an owned awaiting execution. */
  server.put<{
    Params: { executionId: string };
    Body: Buffer;
  }>("/executions/:executionId/request-body", async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) {
      return problem(
        reply,
        400,
        "request_body_required",
        "An application/octet-stream request body is required.",
      );
    }
    try {
      const session = executions.upload(
        (request as AuthenticatedRequest).principalId,
        request.params.executionId,
        request.body,
      );
      return session === undefined
        ? problem(reply, 404, "execution_not_found", "Execution not found.")
        : reply.code(204).send();
    } catch (cause) {
      if (cause instanceof RequestBodyUploadError) {
        return problem(reply, 422, "request_body_invalid", cause.message);
      }
      throw cause;
    }
  });

  /** Returns current control-plane state for an owned execution. */
  server.get<{ Params: { executionId: string } }>(
    "/executions/:executionId",
    async (request, reply) => {
      const session = executions.get(
        (request as AuthenticatedRequest).principalId,
        request.params.executionId,
      );
      return (
        session ??
        problem(reply, 404, "execution_not_found", "Execution not found.")
      );
    },
  );

  /** Streams ordered, resumable response frames for an owned execution. */
  server.get<{
    Params: { executionId: string };
    Querystring: { afterSequence?: string };
  }>("/executions/:executionId/response", async (request, reply) => {
    const afterSequence =
      request.query.afterSequence === undefined
        ? -1
        : Number(request.query.afterSequence);
    const stream = executions.stream(
      (request as AuthenticatedRequest).principalId,
      request.params.executionId,
      afterSequence,
    );
    if (stream === undefined) {
      return problem(reply, 404, "execution_not_found", "Execution not found.");
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/vnd.apinteract.proxy-stream",
      "Cache-Control": "no-store",
    });
    for await (const frame of stream) {
      // Respect socket backpressure while replaying cached frames so a slow
      // backend cannot force unbounded buffering in the proxy process.
      if (!reply.raw.write(frame)) {
        await new Promise<void>((resolve) => reply.raw.once("drain", resolve));
      }
    }
    reply.raw.end();
  });

  /** Requests best-effort cancellation of an owned execution. */
  server.post<{ Params: { executionId: string } }>(
    "/executions/:executionId/cancel",
    async (request, reply) => {
      const session = executions.cancel(
        (request as AuthenticatedRequest).principalId,
        request.params.executionId,
      );
      return (
        session ??
        problem(reply, 404, "execution_not_found", "Execution not found.")
      );
    },
  );

  /** Releases an owned terminal execution and its transient cache. */
  server.delete<{ Params: { executionId: string } }>(
    "/executions/:executionId",
    async (request, reply) => {
      try {
        const released = await executions.release(
          (request as AuthenticatedRequest).principalId,
          request.params.executionId,
        );
        return released
          ? reply.code(204).send()
          : problem(reply, 404, "execution_not_found", "Execution not found.");
      } catch {
        return problem(
          reply,
          409,
          "execution_state_conflict",
          "Only a terminal execution can be released.",
        );
      }
    },
  );

  return server;
}
