import type { VariableResolver } from "../environments/variable-resolver.js";
import type { EntityId } from "../foundation/id.js";
import {
  joinTargetComponents,
  type PreparedExecution,
} from "../requests/request-service.js";
import {
  ScriptExecutionError,
  type ScriptLogEntry,
  type ScriptRequest,
  type ScriptTestResult,
  type ScriptVariable,
} from "../scripting/script-types.js";

/** One script log annotated with the phase that produced it. */
export interface PhasedScriptLog extends ScriptLogEntry {
  readonly phase: "pre-request" | "post-response";
}

/** Sanitized script failure displayed beside an execution result. */
export interface ScriptPhaseError {
  readonly phase: "pre-request" | "post-response";
  readonly code: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

/** Accumulated script output persisted with one execution. */
export interface ScriptSummary {
  readonly logs: readonly PhasedScriptLog[];
  readonly tests: readonly ScriptTestResult[];
  readonly error?: ScriptPhaseError;
}

/** Builds stable execution metadata exposed to both request script phases. */
export function scriptExecutionContext(prepared: PreparedExecution): {
  readonly id: EntityId;
  readonly startedAt: string;
} {
  return {
    id: prepared.executionId,
    startedAt: new Date(prepared.createdAt).toISOString(),
  };
}

/** Projects resolved backend variables without copying secret plaintext. */
export function scriptVariables(
  prepared: PreparedExecution,
  resolver: VariableResolver,
): ScriptVariable[] {
  return prepared.variables.map((variable) => {
    const source = prepared.variableSources.get(variable.name);
    const common = {
      name: variable.name,
      declaredKind: variable.kind,
      sourceScope: source?.scope ?? null,
    };
    if (variable.kind === "unset") {
      return {
        ...common,
        status: "unset",
        effectiveKind: null,
        sensitive: false,
      };
    }
    try {
      const resolved = resolver.resolve(variable.name);
      return {
        ...common,
        status: "resolved",
        effectiveKind: resolved.effectiveKind,
        sensitive: resolved.secret,
        ...(resolved.secret ? {} : { value: resolved.value }),
      };
    } catch {
      return {
        ...common,
        status: "error",
        effectiveKind: null,
        sensitive: variable.kind === "secret",
      };
    }
  });
}

/** Reports whether interpolation would introduce secret plaintext. */
function isSensitiveTemplate(
  value: string,
  resolver: VariableResolver,
): boolean {
  try {
    return resolver.interpolate(value).secret;
  } catch {
    return false;
  }
}

/** Builds the mutable pre-request view from unresolved request templates. */
export function preRequestScriptView(
  request: PreparedExecution["request"],
  resolver: VariableResolver,
): ScriptRequest {
  const targetTemplate =
    request.targetMode === "composed"
      ? joinTargetComponents(request.targetComponents ?? [request.targetUrl])
      : request.targetUrl;
  return {
    method: request.method,
    url: {
      value: targetTemplate,
      readable: true,
      sensitive: isSensitiveTemplate(targetTemplate, resolver),
    },
    headers: request.headers.map((header) => ({
      name: header.name,
      value: header.value,
      readable: true,
      sensitive: isSensitiveTemplate(header.value, resolver),
    })),
    body:
      request.bodyBytes === undefined && !request.bodyPresent
        ? { kind: "none", readable: true, sensitive: false }
        : request.bodyBytes === undefined
          ? {
              kind: "text",
              text: request.body,
              readable: true,
              sensitive: isSensitiveTemplate(request.body, resolver),
            }
          : {
              kind: "binary",
              bytes: request.bodyBytes,
              readable: true,
              sensitive: false,
            },
  };
}

/** Rebuilds an executable request from validated pre-request SDK output. */
export function executionRequestFromScript(
  original: PreparedExecution["request"],
  scripted: ScriptRequest,
): PreparedExecution["request"] {
  if (!scripted.url.readable || scripted.url.value === undefined) {
    throw new ScriptExecutionError(
      "sdk_invalid_argument",
      "Pre-request script left the request URL unreadable",
    );
  }
  if (
    !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
      scripted.method,
    )
  ) {
    throw new ScriptExecutionError(
      "sdk_invalid_argument",
      "Pre-request script selected an unsupported HTTP method",
    );
  }
  if (scripted.url.value.includes("#")) {
    throw new ScriptExecutionError(
      "sdk_invalid_argument",
      "Pre-request script URL must not contain a fragment",
    );
  }
  const separator = scripted.url.value.indexOf("?");
  const targetUrl =
    separator < 0 ? scripted.url.value : scripted.url.value.slice(0, separator);
  const query =
    separator < 0
      ? original.query
      : [...new URLSearchParams(scripted.url.value.slice(separator + 1))].map(
          ([name, value]) => ({ name, value, enabled: true }),
        );
  const headers = scripted.headers.map((header) => {
    if (!header.readable || header.value === undefined) {
      throw new ScriptExecutionError(
        "sdk_invalid_argument",
        `Pre-request script left header ${header.name} unreadable`,
      );
    }
    return { name: header.name, value: header.value, enabled: true };
  });
  const body = scripted.body;
  const { bodyBytes: previousBodyBytes, ...originalWithoutBodyBytes } =
    original;
  void previousBodyBytes;
  return {
    ...originalWithoutBodyBytes,
    method: scripted.method as PreparedExecution["request"]["method"],
    targetMode: "absolute",
    targetUrl,
    targetComponents: [targetUrl],
    query,
    headers,
    body: body.kind === "text" ? (body.text ?? "") : "",
    bodyPresent: body.kind !== "none",
    requestBody:
      body.kind === "text"
        ? {
            kind: "text",
            contentType:
              original.requestBody?.kind === "text"
                ? original.requestBody.contentType
                : null,
            text: body.text ?? "",
          }
        : { kind: "none" },
    ...(body.kind === "binary" && body.bytes !== undefined
      ? { bodyBytes: body.bytes }
      : {}),
  };
}

/** Builds a secret-redacted request view for post-response scripts. */
export function postResponseScriptView(
  template: PreparedExecution["request"],
  materialized: PreparedExecution["request"],
  resolver: VariableResolver,
): ScriptRequest {
  const templateTarget =
    template.targetMode === "composed"
      ? joinTargetComponents(template.targetComponents ?? [template.targetUrl])
      : template.targetUrl;
  const urlSensitive =
    isSensitiveTemplate(templateTarget, resolver) ||
    template.query.some(
      (field) => field.enabled && isSensitiveTemplate(field.value, resolver),
    );
  const finalUrl = materializeTargetUrl(
    materialized.targetUrl,
    materialized.query,
  );
  const bodySensitive = isSensitiveTemplate(template.body, resolver);
  return {
    method: materialized.method,
    url: {
      readable: !urlSensitive,
      sensitive: urlSensitive,
      ...(urlSensitive ? {} : { value: finalUrl }),
    },
    headers: materialized.headers.map((header, index) => {
      const sensitive = isSensitiveTemplate(
        template.headers[index]?.value ?? "",
        resolver,
      );
      return {
        name: header.name,
        readable: !sensitive,
        sensitive,
        ...(sensitive ? {} : { value: header.value }),
      };
    }),
    body:
      materialized.bodyBytes === undefined
        ? {
            kind: "text",
            readable: !bodySensitive,
            sensitive: bodySensitive,
            ...(bodySensitive ? {} : { text: materialized.body }),
          }
        : {
            kind: "binary",
            bytes: materialized.bodyBytes,
            readable: true,
            sensitive: false,
          },
  };
}

/** Converts a sandbox failure to an execution-phase error without diagnostics. */
export function scriptPhaseError(
  cause: unknown,
  phase: ScriptPhaseError["phase"],
): ScriptPhaseError {
  if (!(cause instanceof ScriptExecutionError)) {
    return {
      phase,
      code: "runtime_error",
      message: `An unexpected backend error occurred while running the ${phase} script`,
    };
  }
  return {
    phase,
    code: cause.code,
    message: cause.message,
    ...(cause.line === undefined ? {} : { line: cause.line }),
    ...(cause.column === undefined ? {} : { column: cause.column }),
  };
}

/** Materializes structured query fields for a script-visible request URL. */
function materializeTargetUrl(
  targetUrl: string,
  query: PreparedExecution["request"]["query"],
): string {
  const url = new URL(targetUrl);
  for (const field of query) {
    if (field.enabled) url.searchParams.append(field.name, field.value);
  }
  return url.toString();
}
