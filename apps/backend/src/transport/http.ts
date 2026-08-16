import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Application } from "../bootstrap/application.js";
import type { BackendConfiguration } from "../config.js";
import { AuthenticationFailedError } from "../identity/identity-service.js";
import { RequestAttachmentValidationError } from "../requests/request-attachment-service.js";
import {
  type IssuedSession,
  type SessionIdentity,
} from "../sessions/session-service.js";
import {
  AccessDeniedError,
  ResourceNotFoundError,
} from "../workspaces/workspace-service.js";
import { sendProblem } from "./problem.js";

const REFRESH_COOKIE = "apinteract_refresh";

declare module "fastify" {
  interface FastifyRequest {
    sessionIdentity?: SessionIdentity;
  }
}

/** Registers backend health, session lifecycle, and blob-transfer endpoints. */
export async function registerHttpRoutes(
  server: FastifyInstance,
  application: Application,
  configuration: BackendConfiguration,
): Promise<void> {
  await server.register(cookie);
  server.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: 786_432 },
    (_request, body, done) => done(null, body),
  );

  /** Reports backend readiness, including proxy and audit-outbox dependencies. */
  server.get("/health", async (_request, reply) => {
    const proxyReady = await application.proxy.health();
    const auditReady = (await application.audit.pendingCount()) < 10_000;
    const status = proxyReady && auditReady ? "ready" : "not_ready";
    return reply.code(status === "ready" ? 200 : 503).send({
      status,
      version: "0.0.0",
      checks: {
        database: "ready",
        blobs: "ready",
        proxy: proxyReady ? "ready" : "not_ready",
        audit: auditReady ? "ready" : "not_ready",
      },
    });
  });

  /** Authenticates provider input and issues access plus refresh credentials. */
  server.post<{
    Body: {
      providerId?: unknown;
      fields?: Record<string, unknown>;
    };
  }>("/auth/login", async (request, reply) => {
    if (!validOrigin(request, configuration.server.publicOrigin)) {
      return sendProblem(reply, {
        status: 403,
        code: "origin_not_allowed",
        title: "Origin not allowed",
        detail: "The request origin is not allowed.",
      });
    }
    const username = request.body?.fields?.username;
    const password = request.body?.fields?.password;
    if (
      request.body?.providerId !== "local-password" ||
      typeof username !== "string" ||
      typeof password !== "string"
    ) {
      return sendProblem(reply, {
        status: 400,
        code: "invalid_authentication_input",
        title: "Invalid authentication input",
        detail: "The selected authentication provider input is invalid.",
      });
    }
    try {
      const user = await application.identity.authenticateLocalPassword(
        username,
        password,
      );
      const issued = await application.sessions.create(user);
      setRefreshCookie(reply, issued.refreshToken, configuration);
      return accessCredential(issued);
    } catch (cause) {
      if (cause instanceof AuthenticationFailedError) {
        return sendProblem(reply, {
          status: 401,
          code: "authentication_failed",
          title: "Authentication failed",
          detail: cause.message,
        });
      }
      throw cause;
    }
  });

  /** Rotates the opaque refresh cookie and returns a new access credential. */
  server.post("/auth/refresh", async (request, reply) => {
    if (!validOrigin(request, configuration.server.publicOrigin, true)) {
      return sendProblem(reply, {
        status: 403,
        code: "origin_not_allowed",
        title: "Origin not allowed",
        detail: "The request origin is not allowed.",
      });
    }
    const refreshToken = request.cookies[REFRESH_COOKIE];
    if (refreshToken === undefined) {
      return unauthorized(reply);
    }
    try {
      const issued = await application.sessions.refresh(refreshToken);
      setRefreshCookie(reply, issued.refreshToken, configuration);
      return accessCredential(issued);
    } catch {
      clearRefreshCookie(reply, configuration);
      return unauthorized(reply);
    }
  });

  /** Revokes the bearer-authenticated session and clears its refresh cookie. */
  server.post(
    "/auth/logout",
    { preHandler: authenticateAccess(application) },
    async (request, reply) => {
      const identity = request.sessionIdentity;
      if (identity === undefined) {
        return unauthorized(reply);
      }
      await application.sessions.revoke(identity.sessionId, identity.user.id);
      clearRefreshCookie(reply, configuration);
      return reply.code(204).send();
    },
  );

  /** Returns the current bearer-authenticated application session. */
  server.get(
    "/auth/session",
    { preHandler: authenticateAccess(application) },
    async (request, reply) => {
      const identity = request.sessionIdentity;
      return identity === undefined
        ? unauthorized(reply)
        : currentSession(identity);
    },
  );

  /** Stores one immutable workspace-owned file for multipart request reuse. */
  server.post<{
    Params: { workspaceId: string };
    Headers: {
      "x-apinteract-file-name"?: string;
      "x-apinteract-file-type"?: string;
    };
    Body: Buffer;
  }>(
    "/api/workspaces/:workspaceId/request-attachments",
    {
      preHandler: authenticateAccess(application),
      /** Converts parser size failures to the public problem contract. */
      errorHandler(error, _request, reply) {
        if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
          sendProblem(reply, {
            status: 413,
            code: "request_attachment_too_large",
            title: "Request attachment too large",
            detail: "The request attachment exceeds the 768 KiB limit.",
          });
          return;
        }
        throw error;
      },
    },
    async (request, reply) => {
      const identity = request.sessionIdentity;
      if (identity === undefined) return unauthorized(reply);
      const fileName = decodeUploadHeader(
        request.headers["x-apinteract-file-name"],
      );
      const contentType = decodeUploadHeader(
        request.headers["x-apinteract-file-type"],
        "application/octet-stream",
      );
      if (fileName === null || contentType === null) {
        return sendProblem(reply, {
          status: 400,
          code: "invalid_request_attachment",
          title: "Invalid request attachment",
          detail: "The request attachment metadata is invalid.",
        });
      }
      try {
        const attachment = await application.requestAttachments.upload(
          identity.user.id,
          request.params.workspaceId,
          fileName,
          contentType,
          request.body,
        );
        return reply.code(201).send(attachment);
      } catch (cause) {
        if (
          cause instanceof ResourceNotFoundError ||
          cause instanceof AccessDeniedError
        ) {
          return sendProblem(reply, {
            status: 404,
            code: "workspace_not_found",
            title: "Workspace not found",
            detail: "The workspace does not exist or is not editable.",
          });
        }
        if (cause instanceof RequestAttachmentValidationError) {
          return sendProblem(reply, {
            status: 400,
            code: "invalid_request_attachment",
            title: "Invalid request attachment",
            detail: cause.message,
          });
        }
        throw cause;
      }
    },
  );

  /** Streams exact stored response bytes after execution ownership is verified. */
  server.get<{ Params: { executionId: string } }>(
    "/api/executions/:executionId/body",
    { preHandler: authenticateAccess(application) },
    async (request, reply) => {
      const identity = request.sessionIdentity;
      if (identity === undefined) {
        return unauthorized(reply);
      }
      try {
        const body = await application.executions.getBody(
          identity.user.id,
          request.params.executionId,
        );
        reply
          .header("Content-Length", body.byteLength)
          .header("Digest", `sha-256=${body.sha256}`)
          .type("application/octet-stream");
        return reply.send(application.executions.openBody(body.storageKey));
      } catch (cause) {
        if (
          cause instanceof ResourceNotFoundError ||
          cause instanceof AccessDeniedError
        ) {
          return sendProblem(reply, {
            status: 404,
            code: "execution_body_not_found",
            title: "Execution body not found",
            detail: "The response body does not exist or is not visible.",
          });
        }
        throw cause;
      }
    },
  );
}

/** Decodes one percent-encoded ASCII upload header without throwing. */
function decodeUploadHeader(
  value: string | undefined,
  fallback?: string,
): string | null {
  if (value === undefined) return fallback ?? null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Creates a Fastify pre-handler that authenticates a bearer access token. */
function authenticateAccess(application: Application) {
  return (
    request: FastifyRequest,
    reply: FastifyReply,
    done: (error?: Error) => void,
  ): void => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      unauthorized(reply);
      return;
    }
    void application.sessions
      .authenticateAccessToken(authorization.slice(7))
      .then(
        (identity) => {
          request.sessionIdentity = identity;
          done();
        },
        () => {
          unauthorized(reply);
        },
      );
  };
}

/** Maps an issued backend session to the public access-credential response. */
function accessCredential(issued: IssuedSession) {
  return {
    accessToken: issued.accessToken,
    accessTokenExpiresAt: new Date(issued.accessTokenExpiresAt).toISOString(),
    session: currentSession(issued.identity),
  };
}

/** Maps internal session identity to the frontend's current-session contract. */
function currentSession(identity: SessionIdentity) {
  return {
    sessionId: identity.sessionId,
    user: {
      userId: identity.user.id,
      username: identity.user.username,
      displayName: identity.user.displayName,
    },
    createdAt: new Date(identity.createdAt).toISOString(),
    absoluteExpiresAt: new Date(identity.absoluteExpiresAt).toISOString(),
  };
}

/** Sets the scoped HttpOnly rotating refresh credential cookie. */
function setRefreshCookie(
  reply: Parameters<typeof clearRefreshCookie>[0],
  token: string,
  configuration: BackendConfiguration,
): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    path: "/auth/refresh",
    httpOnly: true,
    sameSite: "lax",
    secure: configuration.sessions.secureCookie,
    maxAge: configuration.sessions.refreshAbsoluteLifetimeSeconds,
  });
}

/** Expires the scoped refresh credential cookie in the browser. */
function clearRefreshCookie(
  reply: FastifyReply,
  configuration: BackendConfiguration,
): void {
  reply.clearCookie(REFRESH_COOKIE, {
    path: "/auth/refresh",
    httpOnly: true,
    sameSite: "lax",
    secure: configuration.sessions.secureCookie,
  });
}

/** Sends the standard authentication-required problem response. */
function unauthorized(reply: FastifyReply) {
  return sendProblem(reply, {
    status: 401,
    code: "authentication_required",
    title: "Authentication required",
    detail: "A valid application session is required.",
  });
}

/** Validates same-origin state-changing requests with an optional absent origin. */
function validOrigin(
  request: FastifyRequest,
  publicOrigin: string,
  requireHeader = false,
): boolean {
  const origin = request.headers.origin;
  return origin === publicOrigin || (!requireHeader && origin === undefined);
}
