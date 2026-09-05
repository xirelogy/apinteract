import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Application } from "../bootstrap/application.js";
import type { BackendConfiguration } from "../config.js";
import {
  AuthenticationFailedError,
  InstanceAlreadyInitializedError,
} from "../identity/identity-service.js";
import {
  AuthenticationInputError,
  AuthenticationRateLimitError,
  type AuthenticationTransition,
} from "../authentication/authentication-service.js";
import { AuthProviderNotConfiguredError } from "../authentication/auth-provider-registry.js";
import {
  WebBootstrapInputError,
  WebBootstrapRateLimitError,
  WebBootstrapUnavailableError,
} from "../authentication/first-user-bootstrap-service.js";
import { idToBytes } from "../foundation/id.js";
import { RequestAttachmentValidationError } from "../requests/request-attachment-service.js";
import {
  type IssuedSession,
  type SessionIdentity,
} from "../sessions/session-service.js";
import {
  AccessDeniedError,
  ResourceNotFoundError,
} from "../workspaces/workspace-service.js";
import { BACKEND_APPLICATION_VERSION } from "../version.js";
import { sendProblem } from "./problem.js";

const REFRESH_COOKIE = "apinteract_refresh";
const AUTH_ATTEMPT_COOKIE = "apinteract_auth_attempt";

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

  /** Reports whether this fresh instance offers local-password web setup. */
  server.get("/auth/bootstrap", async (_request, reply) =>
    reply
      .header("Cache-Control", "no-store")
      .send(await application.firstUserBootstrap.status()),
  );

  /** Atomically creates the first local-password administrator. */
  server.post<{
    Body: {
      providerId?: unknown;
      username?: unknown;
      displayName?: unknown;
      password?: unknown;
    };
  }>("/auth/bootstrap", async (request, reply) => {
    if (!validOrigin(request, configuration.server.publicOrigin)) {
      return originNotAllowed(reply);
    }
    const input = webBootstrapInput(request.body);
    if (input === null) return invalidWebBootstrapInput(reply);
    try {
      await application.firstUserBootstrap.initialize(
        input.providerId,
        input.username,
        input.displayName,
        input.password,
        request.ip,
      );
      return reply.code(204).send();
    } catch (cause) {
      if (cause instanceof InstanceAlreadyInitializedError) {
        return webBootstrapAlreadyCompleted(reply);
      }
      if (cause instanceof WebBootstrapUnavailableError) {
        return webBootstrapUnavailable(reply);
      }
      if (cause instanceof WebBootstrapRateLimitError) {
        return webBootstrapRateLimited(reply);
      }
      if (cause instanceof WebBootstrapInputError) {
        return invalidWebBootstrapInput(reply);
      }
      throw cause;
    }
  });

  /** Lists configured built-in login methods and immutable frontend modules. */
  server.get("/auth/providers", async (_request, reply) =>
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send({
        providers: application.plugins.authProviderCatalog(
          await application.authProviders.descriptors(),
        ),
      }),
  );

  /** Serves one immutable asset from the built-in authentication catalog. */
  server.get<{
    Params: { pluginId: string; hash: string; "*": string };
  }>("/auth/plugins/:pluginId/:hash/*", async (request, reply) => {
    const asset = application.plugins.authProviderAsset(
      request.params.pluginId,
      request.params.hash,
      request.params["*"],
    );
    if (asset === undefined) return reply.code(404).send();
    return reply
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .header("X-Content-Type-Options", "nosniff")
      .type(asset.contentType)
      .send(asset.bytes);
  });

  /** Starts a provider-independent authentication attempt. */
  server.post<{
    Body: { providerId?: unknown; fields?: unknown };
  }>("/auth/attempts", async (request, reply) => {
    if (!validOrigin(request, configuration.server.publicOrigin)) {
      return originNotAllowed(reply);
    }
    const input = authenticationInput(request.body);
    if (input === null) return invalidAuthenticationInput(reply);
    try {
      return sendAuthenticationTransition(
        reply,
        await application.authentication.begin(
          input.providerId,
          input.fields,
          request.ip,
        ),
        application,
        configuration,
      );
    } catch (cause) {
      if (cause instanceof AuthenticationRateLimitError) {
        return authenticationRateLimited(reply);
      }
      if (cause instanceof AuthenticationFailedError) {
        return authenticationFailed(reply);
      }
      if (
        cause instanceof AuthenticationInputError ||
        cause instanceof AuthProviderNotConfiguredError
      ) {
        return invalidAuthenticationInput(reply);
      }
      throw cause;
    }
  });

  /** Continues the active browser-bound authentication attempt. */
  server.post<{
    Params: { attemptId: string };
    Body: { fields?: unknown };
  }>("/auth/attempts/:attemptId/continue", async (request, reply) => {
    if (!validOrigin(request, configuration.server.publicOrigin)) {
      return originNotAllowed(reply);
    }
    const fields = stringFields(request.body?.fields);
    const binding = attemptBinding(request, request.params.attemptId);
    if (
      fields === null ||
      binding === null ||
      !validEntityId(request.params.attemptId)
    ) {
      return invalidAuthenticationInput(reply);
    }
    try {
      return sendAuthenticationTransition(
        reply,
        await application.authentication.continue(
          request.params.attemptId,
          binding,
          fields,
          request.ip,
        ),
        application,
        configuration,
      );
    } catch (cause) {
      if (cause instanceof AuthenticationRateLimitError) {
        return authenticationRateLimited(reply);
      }
      if (cause instanceof AuthenticationFailedError) {
        return authenticationFailed(reply);
      }
      if (
        cause instanceof AuthenticationInputError ||
        cause instanceof AuthProviderNotConfiguredError
      ) {
        return invalidAuthenticationInput(reply);
      }
      throw cause;
    }
  });

  /** Cancels the active browser-bound authentication attempt idempotently. */
  server.delete<{ Params: { attemptId: string } }>(
    "/auth/attempts/:attemptId",
    async (request, reply) => {
      if (!validOrigin(request, configuration.server.publicOrigin)) {
        return originNotAllowed(reply);
      }
      const binding = attemptBinding(request, request.params.attemptId);
      if (binding !== null && validEntityId(request.params.attemptId)) {
        await application.authentication.cancel(
          request.params.attemptId,
          binding,
        );
      }
      clearAttemptCookie(reply, configuration);
      return reply.code(204).send();
    },
  );

  /** Publishes validated frontend plugin metadata without executable details. */
  server.get("/plugins/catalog.json", async (_request, reply) =>
    reply
      .header("Cache-Control", "no-cache")
      .header("X-Content-Type-Options", "nosniff")
      .send({ plugins: application.plugins.frontendCatalog() }),
  );

  /** Serves one immutable asset from a content-addressed frontend package. */
  server.get<{
    Params: { pluginId: string; hash: string; "*": string };
  }>("/plugins/:pluginId/:hash/*", async (request, reply) => {
    const asset = application.plugins.frontendAsset(
      request.params.pluginId,
      request.params.hash,
      request.params["*"],
    );
    if (asset === undefined) return reply.code(404).send();
    return reply
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .header("X-Content-Type-Options", "nosniff")
      .type(asset.contentType)
      .send(asset.bytes);
  });

  /** Reports backend readiness, including proxy and audit-outbox dependencies. */
  server.get("/health", async (_request, reply) => {
    // Keep health checks compatible with lightweight adapters used by callers
    // while the concrete proxy client exposes version metadata.
    const proxyHealth =
      typeof application.proxy.healthDetails === "function"
        ? await application.proxy.healthDetails()
        : {
            ready: await application.proxy.health(),
            protocolVersion: null,
          };
    const proxyReady = proxyHealth.ready;
    const auditReady = (await application.audit.pendingCount()) < 10_000;
    const status = proxyReady && auditReady ? "ready" : "not_ready";
    return reply
      .code(status === "ready" ? 200 : 503)
      .header("Cache-Control", "no-store")
      .send({
        status,
        version: BACKEND_APPLICATION_VERSION,
        proxyProtocolVersion: proxyHealth.protocolVersion,
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
    const input = authenticationInput(request.body);
    if (input === null) return invalidAuthenticationInput(reply);
    try {
      const transition = await application.authentication.begin(
        input.providerId,
        input.fields,
        request.ip,
      );
      if (transition.status !== "authenticated") {
        return transition.status === "unavailable"
          ? authenticationUnavailable(reply)
          : authenticationFailed(reply);
      }
      return issueSession(reply, transition.user, application, configuration);
    } catch (cause) {
      if (cause instanceof AuthenticationRateLimitError) {
        return authenticationRateLimited(reply);
      }
      if (cause instanceof AuthenticationFailedError) {
        return sendProblem(reply, {
          status: 401,
          code: "authentication_failed",
          title: "Authentication failed",
          detail: cause.message,
        });
      }
      if (
        cause instanceof AuthenticationInputError ||
        cause instanceof AuthProviderNotConfiguredError
      ) {
        return invalidAuthenticationInput(reply);
      }
      throw cause;
    }
  });

  /** Rotates the opaque refresh cookie and returns a new access credential. */
  server.post("/auth/refresh", async (request, reply) => {
    if (!validOrigin(request, configuration.server.publicOrigin)) {
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

  /** Stores one immutable workspace-owned file for request-body reuse. */
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

/** Sends one attempt result while keeping session credentials out of plugins. */
async function sendAuthenticationTransition(
  reply: FastifyReply,
  transition: AuthenticationTransition,
  application: Application,
  configuration: BackendConfiguration,
) {
  if (transition.status === "rejected") {
    clearAttemptCookie(reply, configuration);
    return authenticationFailed(reply);
  }
  if (transition.status === "unavailable") {
    clearAttemptCookie(reply, configuration);
    return authenticationUnavailable(reply);
  }
  if (transition.status === "interaction_required") {
    setAttemptCookie(
      reply,
      `${transition.attemptId}.${transition.binding}`,
      configuration,
    );
    return reply.send({
      status: transition.status,
      attemptId: transition.attemptId,
      publicData: transition.publicData,
    });
  }
  clearAttemptCookie(reply, configuration);
  const credential = await createIssuedCredential(
    transition.user,
    application,
    configuration,
    reply,
  );
  return reply.send({ status: "authenticated", credential });
}

/** Issues one core session after provider-independent identity resolution. */
async function issueSession(
  reply: FastifyReply,
  user: Parameters<Application["sessions"]["create"]>[0],
  application: Application,
  configuration: BackendConfiguration,
) {
  return createIssuedCredential(user, application, configuration, reply);
}

/** Creates and serializes a session while setting its refresh cookie. */
async function createIssuedCredential(
  user: Parameters<Application["sessions"]["create"]>[0],
  application: Application,
  configuration: BackendConfiguration,
  reply: FastifyReply,
) {
  const issued = await application.sessions.create(user);
  setRefreshCookie(reply, issued.refreshToken, configuration);
  return accessCredential(issued);
}

/** Parses one generic provider selection plus bounded string field object. */
function authenticationInput(value: unknown): {
  readonly providerId: string;
  readonly fields: Readonly<Record<string, string>>;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  const fields = stringFields(body.fields);
  return typeof body.providerId === "string" && fields !== null
    ? { providerId: body.providerId, fields }
    : null;
}

/** Parses the fixed core and local-password fields accepted during setup. */
function webBootstrapInput(value: unknown): {
  readonly providerId: string;
  readonly username: string;
  readonly displayName: string;
  readonly password: string;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    "providerId",
    "username",
    "displayName",
    "password",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  return typeof body.providerId === "string" &&
    typeof body.username === "string" &&
    typeof body.displayName === "string" &&
    typeof body.password === "string"
    ? {
        providerId: body.providerId,
        username: body.username,
        displayName: body.displayName,
        password: body.password,
      }
    : null;
}

/** Narrows provider evidence to an own-property string map. */
function stringFields(value: unknown): Readonly<Record<string, string>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === "string")
    ? Object.fromEntries(entries)
    : null;
}

/** Extracts an attempt's browser-only secret from its scoped cookie. */
function attemptBinding(
  request: FastifyRequest,
  attemptId: string,
): string | null {
  const value = request.cookies[AUTH_ATTEMPT_COOKIE];
  const separator = value?.indexOf(".") ?? -1;
  return separator > 0 && value?.slice(0, separator) === attemptId
    ? value.slice(separator + 1)
    : null;
}

/** Checks canonical UUIDv7 syntax without retaining converted bytes. */
function validEntityId(value: string): boolean {
  try {
    idToBytes(value);
    return true;
  } catch {
    return false;
  }
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

/** Sets the short-lived HttpOnly browser binding for one active auth attempt. */
function setAttemptCookie(
  reply: FastifyReply,
  value: string,
  configuration: BackendConfiguration,
): void {
  reply.setCookie(AUTH_ATTEMPT_COOKIE, value, {
    path: "/auth/attempts",
    httpOnly: true,
    sameSite: "lax",
    secure: configuration.sessions.secureCookie,
    maxAge: 5 * 60,
  });
}

/** Expires the browser binding after completion or cancellation. */
function clearAttemptCookie(
  reply: FastifyReply,
  configuration: BackendConfiguration,
): void {
  reply.clearCookie(AUTH_ATTEMPT_COOKIE, {
    path: "/auth/attempts",
    httpOnly: true,
    sameSite: "lax",
    secure: configuration.sessions.secureCookie,
  });
}

/** Sends the generic public credential rejection without lookup disclosure. */
function authenticationFailed(reply: FastifyReply) {
  return sendProblem(reply, {
    status: 401,
    code: "authentication_failed",
    title: "Authentication failed",
    detail: "The supplied credentials could not be accepted",
  });
}

/** Reports a configured provider that cannot currently accept attempts. */
function authenticationUnavailable(reply: FastifyReply) {
  return sendProblem(reply, {
    status: 503,
    code: "authentication_provider_unavailable",
    title: "Authentication method unavailable",
    detail: "The selected authentication method is temporarily unavailable.",
  });
}

/** Reports core-owned throttling without disclosing credential validity. */
function authenticationRateLimited(reply: FastifyReply) {
  return sendProblem(reply, {
    status: 429,
    code: "authentication_rate_limited",
    title: "Too many authentication attempts",
    detail: "Wait before trying to authenticate again.",
  });
}

/** Sends the stable provider-independent input validation problem. */
function invalidAuthenticationInput(reply: FastifyReply) {
  return sendProblem(reply, {
    status: 400,
    code: "invalid_authentication_input",
    title: "Invalid authentication input",
    detail: "The selected authentication provider input is invalid.",
  });
}

/** Sends bounded validation feedback without echoing submitted credentials. */
function invalidWebBootstrapInput(reply: FastifyReply) {
  return sendProblem(reply, {
    status: 400,
    code: "invalid_web_bootstrap_input",
    title: "Invalid first-user setup input",
    detail: "Complete every first-user setup field within its allowed length.",
  });
}

/** Reports the permanent one-time initialization conflict. */
function webBootstrapAlreadyCompleted(reply: FastifyReply) {
  return sendProblem(reply, {
    status: 409,
    code: "web_bootstrap_already_completed",
    title: "First-user setup already completed",
    detail: "This APInteract instance has already been initialized.",
  });
}

/** Hides disabled, incompatible, and unhealthy bootstrap paths alike. */
function webBootstrapUnavailable(reply: FastifyReply) {
  return sendProblem(reply, {
    status: 404,
    code: "web_bootstrap_unavailable",
    title: "First-user setup unavailable",
    detail: "Web-based first-user setup is not available.",
  });
}

/** Bounds password hashing work exposed before the first user exists. */
function webBootstrapRateLimited(reply: FastifyReply) {
  return sendProblem(reply, {
    status: 429,
    code: "web_bootstrap_rate_limited",
    title: "Too many setup attempts",
    detail: "Wait before trying first-user setup again.",
  });
}

/** Sends the stable same-origin enforcement problem. */
function originNotAllowed(reply: FastifyReply) {
  return sendProblem(reply, {
    status: 403,
    code: "origin_not_allowed",
    title: "Origin not allowed",
    detail: "The request origin is not allowed.",
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

/** Requires the exact configured browser origin on state-changing cookie routes. */
function validOrigin(request: FastifyRequest, publicOrigin: string): boolean {
  return request.headers.origin === publicOrigin;
}
