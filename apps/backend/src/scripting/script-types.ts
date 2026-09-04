/** Stable JavaScript SDK contract identifier recorded with script results. */
export const SCRIPT_SDK_VERSION = "1";

/** Default limits applied to one isolated script invocation. */
export const DEFAULT_SCRIPT_LIMITS: ScriptLimits = {
  sourceBytes: 65_536,
  inputBytes: 1_048_576,
  outputBytes: 1_048_576,
  bodyBytes: 1_048_576,
  logEntries: 100,
  logBytes: 65_536,
  localVariableCount: 100,
  localVariableBytes: 65_536,
  variableWriteCount: 100,
  variableWriteBytes: 65_536,
  wallTimeMilliseconds: 1000,
  memoryBytes: 16_777_216,
};

/** Resource ceilings exposed to and enforced for one script invocation. */
export interface ScriptLimits {
  readonly sourceBytes: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly bodyBytes: number;
  readonly logEntries: number;
  readonly logBytes: number;
  readonly localVariableCount: number;
  readonly localVariableBytes: number;
  readonly variableWriteCount: number;
  readonly variableWriteBytes: number;
  readonly wallTimeMilliseconds: number;
  readonly memoryBytes: number;
}

/** Persisted destinations that a post-response script can address explicitly. */
export type ScriptVariableWriteScope =
  | "request"
  | "parent-collection"
  | "workspace"
  | "selected-environment";

/** Complete scope set used when deployment configuration does not narrow writes. */
export const SCRIPT_VARIABLE_WRITE_SCOPES = [
  "request",
  "parent-collection",
  "workspace",
  "selected-environment",
] as const satisfies readonly ScriptVariableWriteScope[];

/** Default deployment policy for post-response persistence automation. */
export const DEFAULT_SCRIPT_VARIABLE_WRITE_POLICY: ScriptVariableWritePolicy = {
  allowedScopes: SCRIPT_VARIABLE_WRITE_SCOPES,
  allowSecrets: true,
};

/** Deployment policy copied into a script invocation and rechecked by the host. */
export interface ScriptVariableWritePolicy {
  readonly allowedScopes: readonly ScriptVariableWriteScope[];
  readonly allowSecrets: boolean;
}

/** One validated persistent mutation requested by a post-response script. */
export interface ScriptVariableWrite {
  readonly scope: ScriptVariableWriteScope;
  readonly name: string;
  readonly kind: "value" | "secret";
  readonly value: string;
}

/** Safe execution metadata visible to workspace JavaScript. */
export interface ScriptExecutionContext {
  readonly id: string;
  readonly startedAt: string;
}

/** One request or response header with explicit sensitivity and readability. */
export interface ScriptHeader {
  readonly name: string;
  readonly value?: string;
  readonly readable: boolean;
  readonly sensitive: boolean;
}

/** One request URL with explicit sensitivity and readability. */
export interface ScriptTextValue {
  readonly value?: string;
  readonly readable: boolean;
  readonly sensitive: boolean;
}

/** An absent request body. */
export interface ScriptEmptyBody {
  readonly kind: "none";
  readonly readable: true;
  readonly sensitive: false;
}

/** A UTF-8 request body, optionally hidden from the script. */
export interface ScriptTextBody {
  readonly kind: "text";
  readonly text?: string;
  readonly readable: boolean;
  readonly sensitive: boolean;
}

/** A binary request body, optionally hidden from the script. */
export interface ScriptBinaryBody {
  readonly kind: "binary";
  readonly bytes?: Uint8Array;
  readonly readable: boolean;
  readonly sensitive: boolean;
}

/** Request body representation accepted by the scripting boundary. */
export type ScriptRequestBody =
  | ScriptEmptyBody
  | ScriptTextBody
  | ScriptBinaryBody;

/** Request state copied into or returned from a script invocation. */
export interface ScriptRequest {
  readonly method: string;
  readonly url: ScriptTextValue;
  readonly headers: readonly ScriptHeader[];
  readonly body: ScriptRequestBody;
}

/** Variable resolution state visible without exposing secret plaintext. */
export interface ScriptVariable {
  readonly name: string;
  readonly status: "resolved" | "missing" | "unset" | "error";
  readonly declaredKind: "value" | "secret" | "alias" | "unset" | null;
  readonly effectiveKind: "value" | "secret" | null;
  readonly sensitive: boolean;
  readonly sourceScope:
    | "workspace"
    | "environment"
    | "collection"
    | "request"
    | null;
  readonly value?: string;
}

/** Response body metadata and optionally available complete bytes. */
export interface ScriptResponseBody {
  readonly size: number;
  readonly sha256: string;
  readonly available: boolean;
  readonly unavailableReason?: "too_large" | "not_retained";
  readonly bytes?: Uint8Array;
}

/** Complete target response copied into a post-response invocation. */
export interface ScriptResponse {
  readonly status: number;
  readonly headers: readonly ScriptHeader[];
  readonly body: ScriptResponseBody;
}

/** JSON-safe fields attached to one script log entry. */
export type ScriptLogFields = Readonly<
  Record<string, string | number | boolean | null>
>;

/** One bounded log entry produced by workspace JavaScript. */
export interface ScriptLogEntry {
  readonly sequence: number;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields?: ScriptLogFields;
}

/** Stable localization keys for SDK-generated test details. */
export type ScriptTestMessageCode =
  | "assertion_expected_truthy"
  | "assertion_values_not_equal"
  | "assertion_values_not_deeply_equal"
  | "assertion_value_does_not_match"
  | "test_threw_non_error";

/** One named assertion group produced by a post-response script. */
export interface ScriptTestResult {
  readonly sequence: number;
  readonly name: string;
  readonly status: "passed" | "failed" | "errored";
  readonly message?: string;
  readonly messageCode?: ScriptTestMessageCode;
  /** Stable SDK/runtime code or JavaScript error name, when available. */
  readonly code?: string;
  /** One-based source line reported for the test body failure. */
  readonly line?: number;
  /** One-based source column reported for the test body failure. */
  readonly column?: number;
}

/** Shared copied input for either script phase. */
export interface CommonScriptInput {
  readonly execution: ScriptExecutionContext;
  readonly request: ScriptRequest;
  readonly variables: readonly ScriptVariable[];
  readonly local?: Readonly<Record<string, string>>;
  readonly limits?: Partial<ScriptLimits>;
  readonly variableWritePolicy?: ScriptVariableWritePolicy;
}

/** Copied input for a pre-request script. */
export type PreRequestScriptInput = CommonScriptInput;

/** Copied input for a post-response script. */
export interface PostResponseScriptInput extends CommonScriptInput {
  readonly response: ScriptResponse;
}

/** Successful result of a pre-request script. */
export interface PreRequestScriptResult {
  readonly sdkVersion: string;
  readonly request: ScriptRequest;
  readonly local: Readonly<Record<string, string>>;
  readonly logs: readonly ScriptLogEntry[];
  readonly durationMilliseconds: number;
}

/** Successful result of a post-response script. */
export interface PostResponseScriptResult {
  readonly sdkVersion: string;
  readonly local: Readonly<Record<string, string>>;
  readonly logs: readonly ScriptLogEntry[];
  readonly tests: readonly ScriptTestResult[];
  readonly variableWrites: readonly ScriptVariableWrite[];
  readonly durationMilliseconds: number;
}

/** Stable categories returned when workspace JavaScript cannot complete. */
export type ScriptFailureCode =
  | "syntax_error"
  | "runtime_error"
  | "sdk_invalid_argument"
  | "sdk_permission_denied"
  | "sensitive_value_unavailable"
  | "response_body_unavailable"
  | "cpu_limit_exceeded"
  | "memory_limit_exceeded"
  | "time_limit_exceeded"
  | "output_limit_exceeded"
  | "variable_write_conflict"
  | "variable_write_denied"
  | "cancelled";

/** Sanitized script failure safe to return through an application contract. */
export class ScriptExecutionError extends Error {
  readonly code: ScriptFailureCode;
  readonly line?: number;
  readonly column?: number;

  constructor(
    code: ScriptFailureCode,
    message: string,
    location?: { readonly line?: number; readonly column?: number },
  ) {
    super(message);
    this.name = "ScriptExecutionError";
    this.code = code;
    if (location?.line !== undefined) this.line = location.line;
    if (location?.column !== undefined) this.column = location.column;
  }
}
