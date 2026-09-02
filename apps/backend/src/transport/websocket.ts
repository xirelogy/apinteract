import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";

import type { Application } from "../bootstrap/application.js";
import type { BackendConfiguration } from "../config.js";
import {
  DocumentationValidationError,
  validateFieldDescription,
  validateResourceDescription,
  validateResourceNotes,
} from "../documentation/documentation.js";
import {
  EnvironmentCompositionCycleError,
  EnvironmentCompositionInvalidError,
  EnvironmentConflictError,
  EnvironmentInUseError,
  type EnvironmentVariableWrite,
} from "../environments/environment-service.js";
import { VariableResolutionError } from "../environments/variable-resolver.js";
import { createEntityId } from "../foundation/id.js";
import {
  ImportSourceError,
  type ImportProviderId,
} from "../imports/import-types.js";
import type { RequestAttachmentView } from "../requests/request-attachment-service.js";
import {
  CollectionProfileConflictError,
  DraftConflictError,
  TreeMoveInvalidError,
  TreeOrderConflictError,
  type HttpMethod,
  type RequestBodyDefinition,
  type RequestExecutionInput,
  type RequestField,
  type RequestMultipartField,
  type RequestVariableProfileUpdate,
  type TreeMovePlacement,
} from "../requests/request-service.js";
import type { SessionIdentity } from "../sessions/session-service.js";
import {
  AccessDeniedError,
  ResourceNotFoundError,
  WorkspaceConflictError,
} from "../workspaces/workspace-service.js";
import {
  type EditableVariableScopeKind,
  type TemporaryRequestVariableProfile,
} from "../variables/variable-service.js";
import { VariableProfileConflictError } from "../variables/variable-profile-store.js";

interface Command {
  readonly protocolVersion: 1;
  readonly kind: "command";
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/** Sends transport-level pings often enough to keep upgraded connections alive. */
const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 25_000;

/** Installs a native ping/pong watchdog and returns its cleanup function. */
export function installWebSocketHeartbeat(socket: WebSocket): () => void {
  let alive = true;
  /** Records the peer response required before the next heartbeat interval. */
  const markAlive = (): void => {
    alive = true;
  };
  const timer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, WEBSOCKET_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  socket.on("pong", markAlive);
  return () => {
    clearInterval(timer);
    socket.off("pong", markAlive);
  };
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
    const stopHeartbeat = installWebSocketHeartbeat(socket);
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
    socket.once("close", () => {
      stopHeartbeat();
      clearTimeout(authenticationTimeout);
    });

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
    case "plugin.list":
      return { plugins: application.plugins.backendPlugins() };
    case "workspace.list":
      return { workspaces: await application.workspaces.list(userId) };
    case "workspace.create":
      return application.workspaces.create(
        userId,
        requireString(command.payload.name, "name"),
        requireResourceDescription(command.payload.description),
        requireResourceNotes(command.payload.notes),
      );
    case "workspace.get":
      return application.workspaces.get(
        userId,
        requireString(command.payload.workspaceId, "workspaceId"),
      );
    case "workspace.update":
      return application.workspaces.update(
        userId,
        requireString(command.payload.workspaceId, "workspaceId"),
        requireInteger(command.payload.expectedRevision, "expectedRevision"),
        requireString(command.payload.name, "name"),
        requireRequestFields(command.payload.headers, "headers"),
        requireOptionalString(command.payload.baseUrl, "baseUrl"),
        requireResourceDescription(command.payload.description),
        requireResourceNotes(command.payload.notes),
      );
    case "workspace.delete":
      return application.workspaces.delete(
        userId,
        requireString(command.payload.workspaceId, "workspaceId"),
        requireInteger(command.payload.expectedRevision, "expectedRevision"),
      );
    case "tree.list":
      return {
        children: await application.requests.listChildren(
          userId,
          requireString(command.payload.workspaceId, "workspaceId"),
          optionalString(command.payload.parentCollectionId),
        ),
      };
    case "tree.reorder":
      return application.requests.reorderChildren(
        userId,
        requireString(command.payload.workspaceId, "workspaceId"),
        optionalString(command.payload.parentCollectionId),
        requireInteger(
          command.payload.expectedOrderRevision,
          "expectedOrderRevision",
        ),
        requireNodeIds(command.payload.orderedNodeIds),
      );
    case "tree.move":
      return application.requests.moveNode(
        userId,
        requireString(command.payload.workspaceId, "workspaceId"),
        requireString(command.payload.nodeId, "nodeId"),
        requireString(command.payload.targetNodeId, "targetNodeId"),
        requireTreeMovePlacement(command.payload.placement),
        requireInteger(
          command.payload.expectedSourceOrderRevision,
          "expectedSourceOrderRevision",
        ),
      );
    case "collection.create":
      return application.requests.createCollection(
        userId,
        requireString(command.payload.workspaceId, "workspaceId"),
        optionalString(command.payload.parentCollectionId),
        requireString(command.payload.name, "name"),
        requireResourceDescription(command.payload.description),
        requireResourceNotes(command.payload.notes),
      );
    case "collection.get":
      return application.requests.getCollection(
        userId,
        requireString(command.payload.collectionId, "collectionId"),
      );
    case "collection.update":
      return application.requests.updateCollection(
        userId,
        requireString(command.payload.collectionId, "collectionId"),
        requireInteger(command.payload.expectedRevision, "expectedRevision"),
        requireString(command.payload.name, "name"),
        requireRequestFields(command.payload.headers, "headers"),
        requireOptionalString(command.payload.pathPrefix, "pathPrefix"),
        requireResourceDescription(command.payload.description),
        requireResourceNotes(command.payload.notes),
      );
    case "collection.headers.update":
      return application.requests.updateCollectionHeaders(
        userId,
        requireString(command.payload.collectionId, "collectionId"),
        requireInteger(command.payload.expectedRevision, "expectedRevision"),
        requireRequestFields(command.payload.headers, "headers"),
      );
    case "collection.delete":
      return application.requests.deleteCollection(
        userId,
        requireString(command.payload.collectionId, "collectionId"),
        requireInteger(command.payload.expectedRevision, "expectedRevision"),
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
        requireOptionalEntityIds(
          command.payload.includedEnvironmentIds,
          "includedEnvironmentIds",
        ),
        requireResourceDescription(command.payload.description),
        requireResourceNotes(command.payload.notes),
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
        requireOptionalEntityIds(
          command.payload.includedEnvironmentIds,
          "includedEnvironmentIds",
        ),
        requireResourceDescription(command.payload.description),
        requireResourceNotes(command.payload.notes),
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
    case "variable_profile.get":
      return application.variables.get(
        userId,
        requireVariableScopeKind(command.payload.scopeKind),
        requireString(command.payload.scopeId, "scopeId"),
        identity.sessionId,
      );
    case "variable_profile.get_temporary":
      return application.variables.getTemporary(
        userId,
        identity.sessionId,
        requireString(command.payload.workspaceId, "workspaceId"),
        optionalString(command.payload.parentCollectionId),
        requireString(command.payload.scopeId, "scopeId"),
        requireStringAllowEmpty(command.payload.scopeName, "scopeName"),
      );
    case "variable_profile.update":
      return application.variables.update(
        userId,
        requireVariableScopeKind(command.payload.scopeKind),
        requireString(command.payload.scopeId, "scopeId"),
        requireInteger(command.payload.expectedRevision, "expectedRevision"),
        requireEnvironmentVariables(command.payload.variables),
        identity.sessionId,
      );
    case "variable.preview":
      return application.variables.previewVariables(
        userId,
        identity.sessionId,
        requireString(command.payload.workspaceId, "workspaceId"),
        optionalString(command.payload.parentCollectionId),
        optionalString(command.payload.requestId),
        requireVariableNames(command.payload.names),
        optionalTemporaryRequestVariableProfile(
          command.payload.temporaryVariables,
        ),
      );
    case "import.providers":
      return { providers: application.imports.providers() };
    case "import.preview":
      return application.imports.preview(
        optionalImportProviderId(command.payload.providerId),
        {
          name: requireString(command.payload.sourceName, "sourceName"),
          text: requireStringAllowEmpty(
            command.payload.sourceText,
            "sourceText",
          ),
        },
      );
    case "import.apply":
      return application.imports.apply(
        userId,
        optionalImportProviderId(command.payload.providerId),
        {
          name: requireString(command.payload.sourceName, "sourceName"),
          text: requireStringAllowEmpty(
            command.payload.sourceText,
            "sourceText",
          ),
        },
        {
          workspaceId: requireString(
            command.payload.workspaceId,
            "workspaceId",
          ),
          parentCollectionId: optionalString(
            command.payload.parentCollectionId,
          ),
          collectionName: requireString(
            command.payload.collectionName,
            "collectionName",
          ),
          selectedItemIds: requireImportItemIds(
            command.payload.selectedItemIds,
          ),
          ...(command.payload.requestBodySelections === undefined
            ? {}
            : {
                requestBodySelections: requireImportBodySelections(
                  command.payload.requestBodySelections,
                ),
              }),
          expectedSourceFingerprint: requireString(
            command.payload.expectedSourceFingerprint,
            "expectedSourceFingerprint",
          ),
        },
      );
    case "request.create":
      return application.requests.createRequest(
        userId,
        requireString(command.payload.workspaceId, "workspaceId"),
        optionalString(command.payload.parentCollectionId),
        requireString(command.payload.name, "name"),
        requireMethod(command.payload.method),
        requireStringAllowEmpty(command.payload.targetUrl, "targetUrl"),
        requireRequestFields(command.payload.query, "query"),
        requireRequestFields(command.payload.headers, "headers"),
        requireBody(command.payload.body),
        optionalScript(command.payload.preRequestScript, "preRequestScript"),
        optionalScript(
          command.payload.postResponseScript,
          "postResponseScript",
        ),
        requireTargetMode(command.payload.targetMode),
        optionalRequestBody(command.payload.requestBody),
        {
          variables:
            command.payload.variables === undefined
              ? []
              : requireEnvironmentVariables(command.payload.variables),
          description: requireResourceDescription(command.payload.description),
          notes: requireResourceNotes(command.payload.notes),
        },
      );
    case "request.get":
      return application.requests.get(
        userId,
        requireString(command.payload.requestId, "requestId"),
      );
    case "request.exchange.list":
      return {
        exchanges: await application.requestExchanges.list(
          userId,
          requireString(command.payload.requestId, "requestId"),
        ),
      };
    case "request.exchange.get":
      return application.requestExchanges.get(
        userId,
        requireString(command.payload.requestId, "requestId"),
        requireString(command.payload.exchangeId, "exchangeId"),
        requireRequestExchangeKind(command.payload.kind),
      );
    case "request.revision.list":
      return {
        revisions: await application.requests.listRevisions(
          userId,
          requireString(command.payload.requestId, "requestId"),
        ),
      };
    case "request.revision.get":
      return application.requests.getRevision(
        userId,
        requireString(command.payload.requestId, "requestId"),
        requireString(command.payload.revisionId, "revisionId"),
      );
    case "request.revision.name":
      return application.requests.nameRevision(
        userId,
        requireString(command.payload.requestId, "requestId"),
        requireString(command.payload.revisionId, "revisionId"),
        optionalString(command.payload.name),
      );
    case "request.revision.restore":
      return application.requests.restoreRevision(
        userId,
        requireString(command.payload.requestId, "requestId"),
        requireString(command.payload.revisionId, "revisionId"),
        requireInteger(
          command.payload.expectedDraftRevision,
          "expectedDraftRevision",
        ),
      );
    case "request.duplicate":
      return application.requests.duplicate(
        userId,
        requireString(command.payload.requestId, "requestId"),
        requireString(command.payload.name, "name"),
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
        requireStringAllowEmpty(command.payload.targetUrl, "targetUrl"),
        requireRequestFields(command.payload.query, "query"),
        requireRequestFields(command.payload.headers, "headers"),
        requireBody(command.payload.body),
        optionalScript(command.payload.preRequestScript, "preRequestScript"),
        optionalScript(
          command.payload.postResponseScript,
          "postResponseScript",
        ),
        requireTargetMode(command.payload.targetMode),
        optionalRequestVariableProfileUpdate(command.payload.variableProfile),
        optionalRequestBody(command.payload.requestBody),
        requireResourceDescription(command.payload.description),
        requireResourceNotes(command.payload.notes),
      );
    case "request.delete":
      return application.requests.delete(
        userId,
        requireString(command.payload.requestId, "requestId"),
        requireInteger(
          command.payload.expectedDraftRevision,
          "expectedDraftRevision",
        ),
      );
    case "execution.start":
      return application.executions.start(
        userId,
        identity.sessionId,
        requireString(command.payload.requestId, "requestId"),
        (event) => publishExecutionEvent(event, publish),
      );
    case "execution.start_revision":
      return application.executions.startRevision(
        userId,
        identity.sessionId,
        requireString(command.payload.requestId, "requestId"),
        requireString(command.payload.revisionId, "revisionId"),
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
        optionalTemporaryRequestVariableProfile(
          command.payload.temporaryVariables,
        ),
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
  if (cause instanceof TreeOrderConflictError) {
    return new CommandError("tree_order_conflict", cause.message);
  }
  if (cause instanceof TreeMoveInvalidError) {
    return new CommandError("tree_move_invalid", cause.message);
  }
  if (cause instanceof WorkspaceConflictError) {
    return new CommandError("workspace_conflict", cause.message);
  }
  if (cause instanceof EnvironmentConflictError) {
    return new CommandError("environment_conflict", cause.message);
  }
  if (cause instanceof EnvironmentCompositionCycleError) {
    return new CommandError("environment_composition_cycle", cause.message);
  }
  if (cause instanceof EnvironmentCompositionInvalidError) {
    return new CommandError("environment_composition_invalid", cause.message);
  }
  if (cause instanceof EnvironmentInUseError) {
    return new CommandError("environment_in_use", cause.message);
  }
  if (cause instanceof VariableProfileConflictError) {
    return new CommandError("variable_profile_conflict", cause.message);
  }
  if (cause instanceof VariableResolutionError) {
    return new CommandError("variable_resolution_failed", cause.message);
  }
  if (cause instanceof ImportSourceError) {
    return new CommandError(cause.code, cause.message);
  }
  if (cause instanceof DocumentationValidationError) {
    return new CommandError("validation_failed", cause.message);
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

/** Requires one supported request-exchange storage kind. */
function requireRequestExchangeKind(value: unknown): "execution" | "capture" {
  if (value !== "execution" && value !== "capture") {
    throw new CommandError(
      "validation_failed",
      "kind must be execution or capture.",
    );
  }
  return value;
}

/** Validates a bounded complete sibling order supplied by the tree client. */
function requireNodeIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 2000) {
    throw new CommandError(
      "validation_failed",
      "orderedNodeIds must be a bounded array.",
    );
  }
  return value.map((nodeId) => requireString(nodeId, "nodeId"));
}

/** Requires a supported relative destination for a cross-level tree move. */
function requireTreeMovePlacement(value: unknown): TreeMovePlacement {
  if (value !== "before" && value !== "inside" && value !== "after") {
    throw new CommandError(
      "validation_failed",
      "placement must be before, inside, or after.",
    );
  }
  return value;
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

/** Reads an explicit provider or null for deterministic automatic detection. */
function optionalImportProviderId(value: unknown): ImportProviderId | null {
  if (value === null) return null;
  if (
    typeof value === "string" &&
    value.length <= 100 &&
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(value)
  ) {
    return value;
  }
  throw new CommandError(
    "validation_failed",
    "providerId must be a valid installed provider ID or null.",
  );
}

/** Validates one bounded, duplicate-free selection from a preview plan. */
function requireImportItemIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new CommandError(
      "validation_failed",
      "selectedItemIds must contain between 1 and 200 items.",
    );
  }
  const itemIds = value.map((itemId) => requireString(itemId, "itemId"));
  if (new Set(itemIds).size !== itemIds.length) {
    throw new CommandError(
      "validation_failed",
      "selectedItemIds must not contain duplicates.",
    );
  }
  return itemIds;
}

/** Validates optional provider-defined body choices without interpreting them. */
function requireImportBodySelections(
  value: unknown,
): { readonly itemId: string; readonly optionId: string }[] {
  if (!Array.isArray(value) || value.length > 200) {
    throw new CommandError(
      "validation_failed",
      "requestBodySelections must contain at most 200 items.",
    );
  }
  const selections = value.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new CommandError(
        "validation_failed",
        "requestBodySelections contains an invalid item.",
      );
    }
    const selection = candidate as Record<string, unknown>;
    if (
      Object.keys(selection).some(
        (key) => key !== "itemId" && key !== "optionId",
      )
    ) {
      throw new CommandError(
        "validation_failed",
        "requestBodySelections contains an unsupported field.",
      );
    }
    const itemId = requireString(selection.itemId, "itemId");
    const optionId = requireString(selection.optionId, "optionId");
    if (optionId.length > 200) {
      throw new CommandError(
        "validation_failed",
        "request body optionId must not exceed 200 characters.",
      );
    }
    return { itemId, optionId };
  });
  if (
    new Set(selections.map((selection) => selection.itemId)).size !==
    selections.length
  ) {
    throw new CommandError(
      "validation_failed",
      "requestBodySelections must not contain duplicate request items.",
    );
  }
  return selections;
}

/** Requires an explicit saved-request target interpretation. */
function requireTargetMode(value: unknown): "absolute" | "composed" {
  if (value === "absolute" || value === "composed") return value;
  throw new CommandError(
    "validation_failed",
    "targetMode must be absolute or composed.",
  );
}

/** Accepts a string field while treating omission as a compatibility blank. */
function requireOptionalString(value: unknown, name: string): string {
  return value === undefined ? "" : requireStringAllowEmpty(value, name);
}

/** Validates an optional short resource description with compatibility blank. */
function requireResourceDescription(value: unknown): string {
  return validateResourceDescription(
    value === undefined ? "" : requireStringAllowEmpty(value, "description"),
  );
}

/** Validates optional CommonMark notes with a compatibility blank. */
function requireResourceNotes(value: unknown): string {
  return validateResourceNotes(
    value === undefined ? "" : requireStringAllowEmpty(value, "notes"),
  );
}

/** Requires a string field whose empty value has domain meaning. */
function requireStringAllowEmpty(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new CommandError("validation_failed", `${name} must be a string.`);
  }
  return value;
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
      typeof (field as Record<string, unknown>).enabled !== "boolean" ||
      ((field as Record<string, unknown>).description !== undefined &&
        typeof (field as Record<string, unknown>).description !== "string")
    ) {
      throw new CommandError(
        "validation_failed",
        `${name} contains an invalid field.`,
      );
    }
    const requestField = field as unknown as RequestField;
    const description = validateFieldDescription(requestField.description);
    return description === "" ? requestField : { ...requestField, description };
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
    const description = validateFieldDescription(
      variable.description === undefined
        ? undefined
        : requireStringAllowEmpty(variable.description, "variable description"),
    );
    const common = {
      ...(variable.variableId === undefined
        ? {}
        : { variableId: requireString(variable.variableId, "variableId") }),
      name: requireString(variable.name, "variable name"),
      ...(description === "" ? {} : { description }),
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

/** Validates an optional in-memory request-variable layer for draft workflows. */
function optionalTemporaryRequestVariableProfile(
  value: unknown,
): TemporaryRequestVariableProfile | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CommandError(
      "validation_failed",
      "temporaryVariables must be an object.",
    );
  }
  const profile = value as Record<string, unknown>;
  return {
    scopeId: requireString(profile.scopeId, "temporaryVariables.scopeId"),
    scopeName: requireStringAllowEmpty(
      profile.scopeName,
      "temporaryVariables.scopeName",
    ),
    variables: requireEnvironmentVariables(profile.variables),
  };
}

/** Accepts an optional ordered entity-ID list for additive command fields. */
function requireOptionalEntityIds(
  value: unknown,
  name: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new CommandError("validation_failed", `${name} must be an array.`);
  }
  return value.map((item) => requireString(item, `${name} item`));
}

/** Validates an optional request-variable mutation embedded in a request save. */
function optionalRequestVariableProfileUpdate(
  value: unknown,
): RequestVariableProfileUpdate | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CommandError(
      "validation_failed",
      "variableProfile must be an object.",
    );
  }
  const profile = value as Record<string, unknown>;
  return {
    expectedRevision: requireInteger(
      profile.expectedRevision,
      "variableProfile.expectedRevision",
    ),
    variables: requireEnvironmentVariables(profile.variables),
  };
}

/** Accepts only persisted variable scopes exposed by the generic profile API. */
function requireVariableScopeKind(value: unknown): EditableVariableScopeKind {
  if (value === "workspace" || value === "collection" || value === "request") {
    return value;
  }
  throw new CommandError(
    "validation_failed",
    "scopeKind must be workspace, collection, or request.",
  );
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

/** Validates the additive semantic request-body shape when supplied by a client. */
function optionalRequestBody(
  value: unknown,
): RequestBodyDefinition | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CommandError(
      "validation_failed",
      "requestBody must be an object.",
    );
  }
  const body = value as Record<string, unknown>;
  if (body.kind === "none") {
    if (Object.keys(body).some((key) => key !== "kind")) {
      throw new CommandError(
        "validation_failed",
        "A none requestBody cannot contain content fields.",
      );
    }
    return { kind: "none" };
  }
  if (
    body.kind !== "text" &&
    body.kind !== "file" &&
    body.kind !== "urlencoded" &&
    body.kind !== "multipart"
  ) {
    throw new CommandError(
      "validation_failed",
      "requestBody.kind is not supported.",
    );
  }
  if (body.contentType !== null && typeof body.contentType !== "string") {
    throw new CommandError(
      "validation_failed",
      "requestBody.contentType must be a string or null.",
    );
  }
  if (body.kind === "file") {
    if (
      Object.keys(body).some(
        (key) => !["kind", "contentType", "attachment"].includes(key),
      )
    ) {
      throw new CommandError(
        "validation_failed",
        "A file requestBody contains an unsupported field.",
      );
    }
    return {
      kind: "file",
      contentType: body.contentType,
      attachment: requireRequestAttachment(body.attachment),
    };
  }
  if (body.kind === "urlencoded" || body.kind === "multipart") {
    const allowed =
      body.kind === "multipart"
        ? ["kind", "contentType", "boundary", "fields"]
        : ["kind", "contentType", "fields"];
    if (Object.keys(body).some((key) => !allowed.includes(key))) {
      throw new CommandError(
        "validation_failed",
        `A ${body.kind} requestBody contains an unsupported field.`,
      );
    }
    if (body.kind === "urlencoded") {
      const fields = requireRequestFields(body.fields, "requestBody.fields");
      return { kind: "urlencoded", contentType: body.contentType, fields };
    }
    if (typeof body.boundary !== "string") {
      throw new CommandError(
        "validation_failed",
        "requestBody.boundary must be a string.",
      );
    }
    return {
      kind: "multipart",
      contentType: body.contentType,
      boundary: body.boundary,
      fields: requireMultipartFields(body.fields),
    };
  }
  if (
    Object.keys(body).some(
      (key) => !["kind", "contentType", "text"].includes(key),
    )
  ) {
    throw new CommandError(
      "validation_failed",
      "A text requestBody contains an unsupported field.",
    );
  }
  if (typeof body.text !== "string") {
    throw new CommandError(
      "validation_failed",
      "requestBody.text must be a string.",
    );
  }
  return {
    kind: "text",
    contentType: body.contentType,
    text: body.text,
  };
}

/** Validates ordered multipart text fields and immutable file references. */
function requireMultipartFields(value: unknown): RequestMultipartField[] {
  if (!Array.isArray(value)) {
    throw new CommandError(
      "validation_failed",
      "requestBody.fields must be an array.",
    );
  }
  return value.map((field) => {
    if (typeof field !== "object" || field === null || Array.isArray(field)) {
      throw new CommandError(
        "validation_failed",
        "requestBody.fields contains an invalid field.",
      );
    }
    const item = field as Record<string, unknown>;
    if (item.kind !== "file") {
      return requireRequestFields([field], "requestBody.fields")[0]!;
    }
    if (
      typeof item.name !== "string" ||
      typeof item.enabled !== "boolean" ||
      (item.description !== undefined && typeof item.description !== "string")
    ) {
      throw new CommandError(
        "validation_failed",
        "requestBody.fields contains an invalid file field.",
      );
    }
    const description = validateFieldDescription(item.description);
    return {
      kind: "file",
      name: item.name,
      enabled: item.enabled,
      ...(description === "" ? {} : { description }),
      attachment: requireRequestAttachment(item.attachment),
    };
  });
}

/** Validates immutable upload metadata embedded in a request definition. */
function requireRequestAttachment(value: unknown): RequestAttachmentView {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CommandError(
      "validation_failed",
      "requestBody contains invalid attachment metadata.",
    );
  }
  const metadata = value as Record<string, unknown>;
  if (
    typeof metadata.attachmentId !== "string" ||
    typeof metadata.workspaceId !== "string" ||
    typeof metadata.fileName !== "string" ||
    typeof metadata.contentType !== "string" ||
    typeof metadata.byteLength !== "number" ||
    typeof metadata.sha256 !== "string"
  ) {
    throw new CommandError(
      "validation_failed",
      "requestBody contains invalid attachment metadata.",
    );
  }
  return value as RequestAttachmentView;
}

/** Requires a bounded JavaScript source string, including a disabled blank. */
function requireScript(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new CommandError("validation_failed", `${name} must be a string.`);
  }
  if (Buffer.byteLength(value, "utf8") > 65_536) {
    throw new CommandError("validation_failed", `${name} is too large.`);
  }
  return value;
}

/** Treats omitted script fields from older protocol clients as disabled. */
function optionalScript(value: unknown, name: string): string {
  return value === undefined ? "" : requireScript(value, name);
}

/** Validates a complete executable request snapshot from a command payload. */
function requireExecutionInput(value: unknown): RequestExecutionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CommandError("validation_failed", "request must be an object.");
  }
  const request = value as Record<string, unknown>;
  const requestBody = optionalRequestBody(request.requestBody);
  return {
    method: requireMethod(request.method),
    targetMode: requireTargetMode(request.targetMode),
    targetUrl: requireStringAllowEmpty(request.targetUrl, "targetUrl"),
    query: requireRequestFields(request.query, "query"),
    headers: requireRequestFields(request.headers, "headers"),
    ...(requestBody === undefined ? {} : { requestBody }),
    body: requireBody(request.body),
    preRequestScript: optionalScript(
      request.preRequestScript,
      "preRequestScript",
    ),
    postResponseScript: optionalScript(
      request.postResponseScript,
      "postResponseScript",
    ),
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
