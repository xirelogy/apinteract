import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";

import type { Application } from "../bootstrap/application.js";
import type { BackendConfiguration } from "../config.js";
import {
  EnvironmentConflictError,
  type EnvironmentVariableWrite,
} from "../environments/environment-service.js";
import { VariableResolutionError } from "../environments/variable-resolver.js";
import { createEntityId } from "../foundation/id.js";
import {
  CollectionProfileConflictError,
  DraftConflictError,
  type HttpMethod,
  type RequestExecutionInput,
  type RequestField,
} from "../requests/request-service.js";
import type { SessionIdentity } from "../sessions/session-service.js";
import {
  AccessDeniedError,
  ResourceNotFoundError,
} from "../workspaces/workspace-service.js";

interface Command {
  readonly protocolVersion: 1;
  readonly kind: "command";
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Registers the authenticated frontend control channel.
 *
 * The socket is transport state only: every domain command is dispatched with
 * a backend-verified session identity, and domain services remain responsible
 * for resource authorization.
 */
export async function registerWebSocketRoute(
  server: FastifyInstance,
  application: Application,
  configuration: BackendConfiguration,
): Promise<void> {
  await server.register(websocket, {
    options: {
      maxPayload: 1024 * 1024,
    },
  });

  /** Upgrades an allowed browser origin to the authenticated control channel. */
  server.get("/ws", { websocket: true }, (socket, request) => {
    // Bearer authentication occurs in the first WebSocket command, so an exact
    // Origin check protects the browser handshake from cross-site initiation.
    if (request.headers.origin !== configuration.server.publicOrigin) {
      socket.close(1008, "Origin not allowed");
      return;
    }
    let identity: SessionIdentity | undefined;
    const authenticationTimeout = setTimeout(() => {
      if (identity === undefined) {
        socket.close(1008, "Authentication timeout");
      }
    }, 10_000);

    sendEvent(socket, "system.ready", createEntityId(), {
      protocolVersion: 1,
      backendApiVersion: "0.1.0",
    });

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        socket.close(1003, "Binary control messages are not supported");
        return;
      }
      void handleMessage(rawDataToText(data));
    });
    socket.once("close", () => clearTimeout(authenticationTimeout));

    /** Validates, authenticates, dispatches, and replies to one control command. */
    const handleMessage = async (text: string): Promise<void> => {
      let command: Command;
      try {
        command = parseCommand(text);
      } catch {
        socket.close(1007, "Invalid command");
        return;
      }
      const correlationId = createEntityId();
      try {
        if (command.type === "session.authenticate") {
          const accessToken = requireString(
            command.payload.accessToken,
            "accessToken",
          );
          const authenticated =
            await application.sessions.authenticateAccessToken(accessToken);
          if (
            identity !== undefined &&
            (identity.user.id !== authenticated.user.id ||
              identity.sessionId !== authenticated.sessionId)
          ) {
            // Reauthentication may replace an expiring access token for the
            // same session, but never changes connection ownership.
            throw new CommandError(
              "session_switch_not_allowed",
              "A WebSocket connection cannot switch sessions.",
            );
          }
          identity = authenticated;
          clearTimeout(authenticationTimeout);
          sendSuccess(socket, command.id, correlationId, {
            type: "session.authenticated",
            sessionId: identity.sessionId,
            userId: identity.user.id,
          });
          return;
        }
        if (identity === undefined) {
          throw new CommandError(
            "authentication_required",
            "Authenticate the WebSocket before sending domain commands.",
          );
        }
        const payload = await dispatch(
          application,
          identity,
          command,
          correlationId,
          (type, eventPayload) =>
            sendEvent(socket, type, correlationId, eventPayload),
        );
        sendSuccess(socket, command.id, correlationId, payload);
      } catch (cause) {
        const error = mapCommandError(cause);
        sendError(socket, command.id, correlationId, error.code, error.message);
      }
    };
  });
}

/** Dispatches one authenticated command to its owning domain service. */
async function dispatch(
  application: Application,
  identity: SessionIdentity,
  command: Command,
  correlationId: string,
  publish: (type: string, payload: unknown) => void,
): Promise<unknown> {
  // This switch adapts the public command protocol to domain services. Payload
  // validation belongs here; authorization remains inside those services.
  const userId = identity.user.id;
  switch (command.type) {
    case "system.ping":
      return { type: "system.pong", occurredAt: new Date().toISOString() };
    case "workspace.list":
      return { workspaces: await application.workspaces.list(userId) };
    case "workspace.create":
      return application.workspaces.create(
        userId,
        requireString(command.payload.name, "name"),
      );
    case "tree.list":
      return {
        children: await application.requests.listChildren(
          userId,
          requireString(command.payload.workspaceId, "workspaceId"),
          optionalString(command.payload.parentCollectionId),
        ),
      };
    case "collection.create":
      return application.requests.createCollection(
        userId,
        requireString(command.payload.workspaceId, "workspaceId"),
        optionalString(command.payload.parentCollectionId),
        requireString(command.payload.name, "name"),
      );
    case "collection.get":
      return application.requests.getCollection(
        userId,
        requireString(command.payload.collectionId, "collectionId"),
      );
    case "collection.headers.update":
      return application.requests.updateCollectionHeaders(
        userId,
        requireString(command.payload.collectionId, "collectionId"),
        requireInteger(command.payload.expectedRevision, "expectedRevision"),
        requireRequestFields(command.payload.headers, "headers"),
      );
    case "environment.list":
      return application.environments.list(
        userId,
        identity.sessionId,
        requireString(command.payload.workspaceId, "workspaceId"),
      );
    case "environment.create":
      return application.environments.create(
        userId,
        requireString(command.payload.workspaceId, "workspaceId"),
        requireString(command.payload.name, "name"),
        requireEnvironmentVariables(command.payload.variables),
      );
    case "environment.get":
      return application.environments.get(
        userId,
        requireString(command.payload.environmentId, "environmentId"),
      );
    case "environment.update":
      return application.environments.update(
        userId,
        requireString(command.payload.environmentId, "environmentId"),
        requireInteger(command.payload.expectedRevision, "expectedRevision"),
        requireString(command.payload.name, "name"),
        requireEnvironmentVariables(command.payload.variables),
      );
    case "environment.delete":
      return application.environments.delete(
        userId,
        requireString(command.payload.environmentId, "environmentId"),
        requireInteger(command.payload.expectedRevision, "expectedRevision"),
      );
    case "environment.select":
      return application.environments.select(
        userId,
        identity.sessionId,
        requireString(command.payload.workspaceId, "workspaceId"),
        optionalEnvironmentId(command.payload.environmentId),
      );
    case "environment.preview_variables":
      return application.environments.previewVariables(
        userId,
        identity.sessionId,
        requireString(command.payload.workspaceId, "workspaceId"),
        requireVariableNames(command.payload.names),
      );
    case "request.create":
      return application.requests.createRequest(
        userId,
        requireString(command.payload.workspaceId, "workspaceId"),
        optionalString(command.payload.parentCollectionId),
        requireString(command.payload.name, "name"),
        requireMethod(command.payload.method),
        requireString(command.payload.targetUrl, "targetUrl"),
        requireRequestFields(command.payload.query, "query"),
        requireRequestFields(command.payload.headers, "headers"),
        requireBody(command.payload.body),
      );
    case "request.get":
      return application.requests.get(
        userId,
        requireString(command.payload.requestId, "requestId"),
      );
    case "request.update":
      return application.requests.update(
        userId,
        requireString(command.payload.requestId, "requestId"),
        requireInteger(
          command.payload.expectedDraftRevision,
          "expectedDraftRevision",
        ),
        requireString(command.payload.name, "name"),
        requireMethod(command.payload.method),
        requireString(command.payload.targetUrl, "targetUrl"),
        requireRequestFields(command.payload.query, "query"),
        requireRequestFields(command.payload.headers, "headers"),
        requireBody(command.payload.body),
      );
    case "execution.start":
      return application.executions.start(
        userId,
        identity.sessionId,
        requireString(command.payload.requestId, "requestId"),
        (event) => publishExecutionEvent(event, publish),
      );
    case "execution.start_temporary":
      return application.executions.startTemporary(
        userId,
        identity.sessionId,
        requireString(command.payload.workspaceId, "workspaceId"),
        optionalString(command.payload.parentCollectionId),
        requireExecutionInput(command.payload.request),
        (event) => publishExecutionEvent(event, publish),
      );
    default:
      throw new CommandError(
        "command_not_supported",
        `Command ${command.type} is not supported.`,
      );
  }
}

class CommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Maps domain and validation failures to stable WebSocket command errors. */
function mapCommandError(cause: unknown): CommandError {
  if (cause instanceof CommandError) {
    return cause;
  }
  if (cause instanceof AccessDeniedError) {
    return new CommandError("access_denied", "The operation is not allowed.");
  }
  if (cause instanceof ResourceNotFoundError) {
    return new CommandError("resource_not_found", cause.message);
  }
  if (cause instanceof DraftConflictError) {
    return new CommandError("request_draft_conflict", cause.message);
  }
  if (cause instanceof CollectionProfileConflictError) {
    return new CommandError("collection_profile_conflict", cause.message);
  }
  if (cause instanceof EnvironmentConflictError) {
    return new CommandError("environment_conflict", cause.message);
  }
  if (cause instanceof VariableResolutionError) {
    return new CommandError("variable_resolution_failed", cause.message);
  }
  return new CommandError(
    "invalid_command",
    cause instanceof Error
      ? cause.message
      : "The command could not be processed.",
  );
}

/** Parses and validates the version 1 JSON command envelope. */
function parseCommand(text: string): Command {
  const value = JSON.parse(text) as Partial<Command>;
  if (
    value.protocolVersion !== 1 ||
    value.kind !== "command" ||
    typeof value.id !== "string" ||
    typeof value.type !== "string" ||
    typeof value.payload !== "object" ||
    value.payload === null ||
    Array.isArray(value.payload)
  ) {
    throw new Error("Invalid command envelope");
  }
  return value as Command;
}

/** Sends a successful command reply with correlation metadata. */
function sendSuccess(
  socket: { send(data: string): void },
  commandId: string,
  correlationId: string,
  payload: unknown,
): void {
  socket.send(
    JSON.stringify({
      protocolVersion: 1,
      kind: "reply",
      commandId,
      outcome: "success",
      correlationId,
      payload,
    }),
  );
}

/** Sends a failed command reply with a stable machine-readable code. */
function sendError(
  socket: { send(data: string): void },
  commandId: string,
  correlationId: string,
  code: string,
  message: string,
): void {
  socket.send(
    JSON.stringify({
      protocolVersion: 1,
      kind: "reply",
      commandId,
      outcome: "error",
      correlationId,
      error: { code, message, errors: [] },
    }),
  );
}

/** Publishes an asynchronous control event with identity and correlation data. */
function sendEvent(
  socket: { send(data: string): void },
  type: string,
  correlationId: string,
  payload: unknown,
): void {
  socket.send(
    JSON.stringify({
      protocolVersion: 1,
      kind: "event",
      id: createEntityId(),
      type,
      occurredAt: new Date().toISOString(),
      correlationId,
      payload,
    }),
  );
}

/** Requires a non-empty string command field. */
function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CommandError("validation_failed", `${name} is required.`);
  }
  return value;
}

/** Reads a nullable collection identifier from a command payload. */
function optionalString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return requireString(value, "parentCollectionId");
}

/** Reads a nullable selected environment identifier. */
function optionalEnvironmentId(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return requireString(value, "environmentId");
}

/** Requires a non-negative safe integer command field. */
function requireInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CommandError(
      "validation_failed",
      `${name} must be a non-negative integer.`,
    );
  }
  return value as number;
}

/** Requires a method token supported by saved request drafts. */
function requireMethod(value: unknown): HttpMethod {
  if (
    value === "GET" ||
    value === "POST" ||
    value === "PUT" ||
    value === "PATCH" ||
    value === "DELETE" ||
    value === "HEAD" ||
    value === "OPTIONS"
  ) {
    return value;
  }
  throw new CommandError("validation_failed", "method is not supported.");
}

/** Validates the shape of editable query or header field arrays. */
function requireRequestFields(value: unknown, name: string): RequestField[] {
  if (!Array.isArray(value)) {
    throw new CommandError("validation_failed", `${name} must be an array.`);
  }
  return value.map((field) => {
    if (
      typeof field !== "object" ||
      field === null ||
      Array.isArray(field) ||
      typeof (field as Record<string, unknown>).name !== "string" ||
      typeof (field as Record<string, unknown>).value !== "string" ||
      typeof (field as Record<string, unknown>).enabled !== "boolean"
    ) {
      throw new CommandError(
        "validation_failed",
        `${name} contains an invalid field.`,
      );
    }
    return field as unknown as RequestField;
  });
}

/** Validates discriminated environment-variable writes without reading secrets. */
function requireEnvironmentVariables(
  value: unknown,
): EnvironmentVariableWrite[] {
  if (!Array.isArray(value)) {
    throw new CommandError("validation_failed", "variables must be an array.");
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new CommandError(
        "validation_failed",
        "variables contains an invalid field.",
      );
    }
    const variable = item as Record<string, unknown>;
    const common = {
      ...(variable.variableId === undefined
        ? {}
        : { variableId: requireString(variable.variableId, "variableId") }),
      name: requireString(variable.name, "variable name"),
    };
    switch (variable.kind) {
      case "value":
        return { ...common, kind: "value", value: requireBody(variable.value) };
      case "alias":
        return {
          ...common,
          kind: "alias",
          target: requireString(variable.target, "alias target"),
        };
      case "unset":
        return { ...common, kind: "unset" };
      case "secret":
        if (
          variable.value !== undefined &&
          typeof variable.value !== "string"
        ) {
          throw new CommandError(
            "validation_failed",
            "secret value must be a string.",
          );
        }
        if (
          variable.clearValue !== undefined &&
          typeof variable.clearValue !== "boolean"
        ) {
          throw new CommandError(
            "validation_failed",
            "clearValue must be a boolean.",
          );
        }
        return {
          ...common,
          kind: "secret",
          ...(variable.value === undefined ? {} : { value: variable.value }),
          ...(variable.clearValue === undefined
            ? {}
            : { clearValue: variable.clearValue }),
        };
      default:
        throw new CommandError(
          "validation_failed",
          "variable kind is not supported.",
        );
    }
  });
}

/** Validates a bounded unique list of variable names requested for preview. */
function requireVariableNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new CommandError(
      "validation_failed",
      "names must be an array containing at most 100 items.",
    );
  }
  const names = value.map((name) => {
    const parsed = requireString(name, "variable name");
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(parsed)) {
      throw new CommandError(
        "validation_failed",
        `Variable name ${parsed} is invalid.`,
      );
    }
    return parsed;
  });
  if (new Set(names).size !== names.length) {
    throw new CommandError(
      "validation_failed",
      "names must not contain duplicates.",
    );
  }
  return names;
}

/** Requires a raw request body string, including the valid empty body. */
function requireBody(value: unknown): string {
  if (typeof value !== "string") {
    throw new CommandError("validation_failed", "body must be a string.");
  }
  return value;
}

/** Validates a complete executable request snapshot from a command payload. */
function requireExecutionInput(value: unknown): RequestExecutionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CommandError("validation_failed", "request must be an object.");
  }
  const request = value as Record<string, unknown>;
  return {
    method: requireMethod(request.method),
    targetUrl: requireString(request.targetUrl, "targetUrl"),
    query: requireRequestFields(request.query, "query"),
    headers: requireRequestFields(request.headers, "headers"),
    body: requireBody(request.body),
  };
}

/** Publishes execution identity alongside incremental or terminal event data. */
function publishExecutionEvent(
  event: {
    readonly type: string;
    readonly executionId: string;
    readonly payload: unknown;
  },
  publish: (type: string, payload: unknown) => void,
): void {
  publish(event.type, {
    executionId: event.executionId,
    data: event.payload,
  });
}

/** Converts any supported ws text-frame representation to UTF-8 text. */
function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}
