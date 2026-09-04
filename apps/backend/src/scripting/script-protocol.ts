import {
  ScriptExecutionError,
  type ScriptBinaryBody,
  type ScriptEmptyBody,
  type ScriptFailureCode,
  type ScriptHeader,
  type ScriptLimits,
  type ScriptLogEntry,
  type ScriptRequest,
  type ScriptRequestBody,
  type ScriptResponse,
  type ScriptTestResult,
  type ScriptTextBody,
  type ScriptTextValue,
  type ScriptVariable,
  type ScriptVariableWrite,
} from "./script-types.js";

/** JSON-safe request body exchanged with the isolated script worker. */
interface WireBody {
  readonly kind: "none" | "text" | "binary";
  readonly readable: boolean;
  readonly sensitive: boolean;
  readonly text?: string;
  readonly base64?: string;
}

/** JSON-safe request exchanged with the isolated script worker. */
export interface WireRequest {
  readonly method: string;
  readonly url: WireTextValue;
  readonly headers: readonly WireHeader[];
  readonly body: WireBody;
}

/** JSON-safe text value exchanged with the isolated script worker. */
interface WireTextValue {
  readonly readable: boolean;
  readonly sensitive: boolean;
  readonly value?: string;
}

/** JSON-safe header exchanged with the isolated script worker. */
interface WireHeader {
  readonly name: string;
  readonly readable: boolean;
  readonly sensitive: boolean;
  readonly value?: string;
}

/** JSON-safe response body exchanged with the isolated script worker. */
interface WireResponseBody {
  readonly size: number;
  readonly sha256: string;
  readonly available: boolean;
  readonly unavailableReason?: "too_large" | "not_retained";
  readonly base64?: string;
}

/** JSON-safe response exchanged with the isolated script worker. */
export interface WireResponse {
  readonly status: number;
  readonly headers: readonly WireHeader[];
  readonly body: WireResponseBody;
}

/** Successful response envelope emitted by an isolated worker. */
export interface WorkerSuccess {
  readonly ok: true;
  readonly result: {
    readonly sdkVersion: string;
    readonly request?: WireRequest;
    readonly local: Readonly<Record<string, string>>;
    readonly logs: readonly unknown[];
    readonly tests?: readonly unknown[];
    readonly variableWrites?: readonly unknown[];
  };
}

/** Sanitized failure response envelope emitted by an isolated worker. */
interface WorkerFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly line?: number;
    readonly column?: number;
  };
}

/** Complete private response protocol emitted by an isolated worker. */
type WorkerResponse = WorkerSuccess | WorkerFailure;

/** Converts a public text value to the JSON worker representation. */
function toWireTextValue(
  value: ScriptTextValue,
  redactSensitive = false,
): WireTextValue {
  const readable = value.readable && !(redactSensitive && value.sensitive);
  return {
    readable,
    sensitive: value.sensitive,
    ...(readable && value.value !== undefined ? { value: value.value } : {}),
  };
}

/** Converts a public header to the JSON worker representation. */
function toWireHeader(
  value: ScriptHeader,
  redactSensitive = false,
): WireHeader {
  const readable = value.readable && !(redactSensitive && value.sensitive);
  return {
    name: value.name,
    readable,
    sensitive: value.sensitive,
    ...(readable && value.value !== undefined ? { value: value.value } : {}),
  };
}

/** Converts a public body to the JSON worker representation. */
function toWireBody(
  value: ScriptRequestBody,
  redactSensitive = false,
): WireBody {
  if (value.kind === "none") return value;
  const readable = value.readable && !(redactSensitive && value.sensitive);
  if (value.kind === "text") {
    return {
      kind: value.kind,
      readable,
      sensitive: value.sensitive,
      ...(readable && value.text !== undefined ? { text: value.text } : {}),
    };
  }
  return {
    kind: value.kind,
    readable,
    sensitive: value.sensitive,
    ...(readable && value.bytes !== undefined
      ? { base64: Buffer.from(value.bytes).toString("base64") }
      : {}),
  };
}

/** Converts a public request to the JSON worker representation. */
export function toWireRequest(
  value: ScriptRequest,
  phase: "pre-request" | "post-response",
): WireRequest {
  const redactSensitive = phase === "post-response";
  return {
    method: value.method,
    url: toWireTextValue(value.url, redactSensitive),
    headers: value.headers.map((header) =>
      toWireHeader(header, redactSensitive),
    ),
    body: toWireBody(value.body, redactSensitive),
  };
}

/** Removes secret plaintext before variables enter the isolated context. */
export function toWireVariable(value: ScriptVariable): Record<string, unknown> {
  return {
    name: value.name,
    status: value.status,
    declaredKind: value.declaredKind,
    effectiveKind: value.effectiveKind,
    sensitive: value.sensitive,
    sourceScope: value.sourceScope,
    ...(value.sensitive || value.effectiveKind === "secret"
      ? {}
      : value.value === undefined
        ? {}
        : { value: value.value }),
  };
}

/** Converts a complete response to the JSON worker representation. */
export function toWireResponse(
  value: ScriptResponse,
  limits: ScriptLimits,
): WireResponse {
  const bodyAvailable = value.body.available && value.body.bytes !== undefined;
  const bodyBytes = bodyAvailable ? value.body.bytes : undefined;
  const withinLimit =
    bodyBytes === undefined || bodyBytes.byteLength <= limits.bodyBytes;
  const bodyData =
    bodyBytes !== undefined && withinLimit
      ? { base64: Buffer.from(bodyBytes).toString("base64") }
      : {
          unavailableReason:
            value.body.unavailableReason ??
            (bodyBytes === undefined ? "not_retained" : "too_large"),
        };
  return {
    status: value.status,
    headers: value.headers.map((header) => toWireHeader(header)),
    body: {
      size: value.body.size,
      sha256: value.body.sha256,
      available: bodyAvailable && withinLimit,
      ...bodyData,
    },
  };
}

/** Converts a worker body back to the public scripting representation. */
function fromWireBody(value: WireBody): ScriptRequestBody {
  if (value.kind === "none") {
    const body: ScriptEmptyBody = {
      kind: "none",
      readable: true,
      sensitive: false,
    };
    return body;
  }
  if (value.kind === "text") {
    const body: ScriptTextBody = {
      kind: "text",
      readable: value.readable,
      sensitive: value.sensitive,
      ...(value.readable && value.text !== undefined
        ? { text: value.text }
        : {}),
    };
    return body;
  }
  const body: ScriptBinaryBody = {
    kind: "binary",
    readable: value.readable,
    sensitive: value.sensitive,
    ...(value.readable && value.base64 !== undefined
      ? { bytes: Buffer.from(value.base64, "base64") }
      : {}),
  };
  return body;
}

/** Converts a worker request back to the public scripting representation. */
export function fromWireRequest(value: WireRequest): ScriptRequest {
  return {
    method: value.method,
    url: value.url,
    headers: value.headers,
    body: fromWireBody(value.body),
  };
}

/** Validates and converts worker logs into bounded public results. */
export function validateLogs(
  value: readonly unknown[],
): readonly ScriptLogEntry[] {
  if (!Array.isArray(value)) {
    throw new ScriptExecutionError("runtime_error", "Script logs are invalid");
  }
  return value.map((entry) => {
    const record = isRecord(entry) ? entry : undefined;
    const sequence = record?.sequence;
    const level = record?.level;
    const message = record?.message;
    if (
      record === undefined ||
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      typeof level !== "string" ||
      !["debug", "info", "warn", "error"].includes(level) ||
      typeof message !== "string"
    ) {
      throw new ScriptExecutionError(
        "runtime_error",
        "Script log entry is invalid",
      );
    }
    const fields = validateLogFields(record.fields);
    return {
      sequence,
      level: level as ScriptLogEntry["level"],
      message,
      ...(fields === undefined ? {} : { fields }),
    };
  });
}

/** Validates and converts worker tests into bounded public results. */
export function validateTests(
  value: readonly unknown[] | undefined,
): readonly ScriptTestResult[] {
  if (!Array.isArray(value)) {
    throw new ScriptExecutionError("runtime_error", "Script tests are invalid");
  }
  return value.map((entry) => {
    const record = isRecord(entry) ? entry : undefined;
    const sequence = record?.sequence;
    const name = record?.name;
    const status = record?.status;
    const message = record?.message;
    const messageCode = record?.messageCode;
    const code = record?.code;
    const line = record?.line;
    const column = record?.column;
    if (
      record === undefined ||
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      typeof name !== "string" ||
      typeof status !== "string" ||
      !["passed", "failed", "errored"].includes(status) ||
      (message !== undefined && typeof message !== "string") ||
      (code !== undefined &&
        (typeof code !== "string" || code.length === 0 || code.length > 100)) ||
      (line !== undefined &&
        (typeof line !== "number" ||
          !Number.isSafeInteger(line) ||
          line < 1)) ||
      (column !== undefined &&
        (typeof column !== "number" ||
          !Number.isSafeInteger(column) ||
          column < 1)) ||
      (messageCode !== undefined &&
        (typeof messageCode !== "string" ||
          ![
            "assertion_expected_truthy",
            "assertion_values_not_equal",
            "assertion_values_not_deeply_equal",
            "assertion_value_does_not_match",
            "test_threw_non_error",
          ].includes(messageCode)))
    ) {
      throw new ScriptExecutionError(
        "runtime_error",
        "Script test result is invalid",
      );
    }
    return {
      sequence,
      name,
      status: status as ScriptTestResult["status"],
      ...(typeof message === "string" ? { message } : {}),
      ...(typeof code === "string" ? { code } : {}),
      ...(typeof line === "number" ? { line } : {}),
      ...(typeof column === "number" ? { column } : {}),
      ...(typeof messageCode === "string"
        ? {
            messageCode: messageCode as NonNullable<
              ScriptTestResult["messageCode"]
            >,
          }
        : {}),
    };
  });
}

/** Validates persistent variable intents returned by the isolated worker. */
export function validateVariableWrites(
  value: readonly unknown[] | undefined,
): readonly ScriptVariableWrite[] {
  if (!Array.isArray(value)) {
    throw new ScriptExecutionError(
      "runtime_error",
      "Script variable writes are invalid",
    );
  }
  const scopes = new Set([
    "request",
    "parent-collection",
    "workspace",
    "selected-environment",
  ]);
  return value.map((entry) => {
    const item = isRecord(entry) ? entry : undefined;
    if (
      item === undefined ||
      typeof item.scope !== "string" ||
      !scopes.has(item.scope) ||
      typeof item.name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(item.name) ||
      (item.kind !== "value" && item.kind !== "secret") ||
      typeof item.value !== "string"
    ) {
      throw new ScriptExecutionError(
        "runtime_error",
        "Script variable write is invalid",
      );
    }
    return {
      scope: item.scope as ScriptVariableWrite["scope"],
      name: item.name,
      kind: item.kind,
      value: item.value,
    };
  });
}

/** Validates optional scalar log fields returned by the worker. */
function validateLogFields(
  value: unknown,
): ScriptLogEntry["fields"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ScriptExecutionError(
      "runtime_error",
      "Script log fields are invalid",
    );
  }
  for (const item of Object.values(value)) {
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      throw new ScriptExecutionError(
        "runtime_error",
        "Script log field is invalid",
      );
    }
  }
  return value as ScriptLogEntry["fields"];
}

/** Validates worker-local values before exposing them to backend callers. */
export function validateLocal(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ScriptExecutionError(
      "runtime_error",
      "Script local values are invalid",
    );
  }
  for (const [name, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(name) || typeof item !== "string") {
      throw new ScriptExecutionError(
        "runtime_error",
        "Script local value is invalid",
      );
    }
  }
  return value;
}

/** Converts a worker failure into a host-safe typed error. */
export function toScriptError(
  value: WorkerFailure["error"],
): ScriptExecutionError {
  const codes = new Set([
    "syntax_error",
    "runtime_error",
    "sdk_invalid_argument",
    "sdk_permission_denied",
    "sensitive_value_unavailable",
    "response_body_unavailable",
    "cpu_limit_exceeded",
    "memory_limit_exceeded",
    "time_limit_exceeded",
    "output_limit_exceeded",
    "cancelled",
  ]);
  const code = codes.has(value.code) ? value.code : "runtime_error";
  return new ScriptExecutionError(
    code as ScriptFailureCode,
    value.message.slice(0, 1000),
    {
      ...(value.line === undefined ? {} : { line: value.line }),
      ...(value.column === undefined ? {} : { column: value.column }),
    },
  );
}

/** Narrows an unknown worker value to a string-keyed object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Checks a worker text value before request conversion. */
function isWireTextValue(value: unknown): value is WireTextValue {
  if (!isRecord(value)) return false;
  return (
    typeof value.readable === "boolean" &&
    typeof value.sensitive === "boolean" &&
    (value.value === undefined || typeof value.value === "string")
  );
}

/** Checks one worker header before request conversion. */
function isWireHeader(value: unknown): value is WireHeader {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.readable === "boolean" &&
    typeof value.sensitive === "boolean" &&
    (value.value === undefined || typeof value.value === "string")
  );
}

/** Checks one worker request body before request conversion. */
function isWireBody(value: unknown): value is WireBody {
  if (
    !isRecord(value) ||
    !["none", "text", "binary"].includes(String(value.kind)) ||
    typeof value.readable !== "boolean" ||
    typeof value.sensitive !== "boolean"
  ) {
    return false;
  }
  if (value.kind === "none") return true;
  if (value.kind === "text") {
    return value.text === undefined || typeof value.text === "string";
  }
  return (
    value.base64 === undefined ||
    (typeof value.base64 === "string" &&
      value.base64.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/u.test(value.base64))
  );
}

/** Checks a complete worker request before exposing its mutations. */
function isWireRequest(value: unknown): value is WireRequest {
  if (!isRecord(value)) return false;
  return (
    typeof value.method === "string" &&
    value.method.length > 0 &&
    isWireTextValue(value.url) &&
    Array.isArray(value.headers) &&
    value.headers.every(isWireHeader) &&
    isWireBody(value.body)
  );
}

/** Checks the worker response envelope before its data is consumed. */
export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!isRecord(value) || (value.ok !== true && value.ok !== false))
    return false;
  if (value.ok === false) {
    return (
      isRecord(value.error) &&
      typeof value.error.code === "string" &&
      typeof value.error.message === "string" &&
      (value.error.line === undefined ||
        typeof value.error.line === "number") &&
      (value.error.column === undefined ||
        typeof value.error.column === "number")
    );
  }
  if (!isRecord(value.result)) return false;
  return (
    typeof value.result.sdkVersion === "string" &&
    isRecord(value.result.local) &&
    Array.isArray(value.result.logs) &&
    (value.result.tests === undefined || Array.isArray(value.result.tests)) &&
    (value.result.variableWrites === undefined ||
      Array.isArray(value.result.variableWrites)) &&
    (value.result.request === undefined || isWireRequest(value.result.request))
  );
}
