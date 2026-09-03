import { getQuickJS, isFail } from "quickjs-emscripten";

interface WorkerLimits {
  readonly memoryBytes: number;
  readonly wallTimeMilliseconds: number;
}

interface WorkerInvocation {
  readonly phase: "pre-request" | "post-response";
  readonly source: string;
  readonly limits: WorkerLimits;
  readonly [key: string]: unknown;
}

interface WorkerFailure {
  readonly code: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

/** Carries one sanitized guest failure through worker control flow. */
class WorkerScriptError extends Error {
  readonly code: string;
  readonly line?: number;
  readonly column?: number;

  constructor(failure: WorkerFailure) {
    super(failure.message);
    this.name = "WorkerScriptError";
    this.code = failure.code;
    if (failure.line !== undefined) this.line = failure.line;
    if (failure.column !== undefined) this.column = failure.column;
  }
}

/** Reads and bounds the single invocation supplied over the private IPC channel. */
async function readInvocation(): Promise<WorkerInvocation> {
  const value: unknown = await new Promise((resolve, reject) => {
    process.once("message", resolve);
    process.once("disconnect", () =>
      reject(new Error("Script worker disconnected before receiving input")),
    );
  });
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 18_874_368) {
    throw new Error("Script invocation input exceeds the worker limit");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    !("phase" in value) ||
    (value.phase !== "pre-request" && value.phase !== "post-response") ||
    !("source" in value) ||
    typeof value.source !== "string" ||
    !("limits" in value) ||
    value.limits === null ||
    typeof value.limits !== "object" ||
    !("memoryBytes" in value.limits) ||
    typeof value.limits.memoryBytes !== "number" ||
    !("wallTimeMilliseconds" in value.limits) ||
    typeof value.limits.wallTimeMilliseconds !== "number"
  ) {
    throw new Error("Script invocation input is invalid");
  }
  return value as WorkerInvocation;
}

/** Extracts the best available source position from a QuickJS exception. */
function sourceLocation(value: Readonly<Record<string, unknown>>): {
  readonly line?: number;
  readonly column?: number;
} {
  const directLine = value.lineNumber;
  const directColumn = value.columnNumber;
  if (typeof directLine === "number") {
    return {
      line: directLine,
      ...(typeof directColumn === "number" ? { column: directColumn } : {}),
    };
  }
  if (typeof value.stack !== "string") return {};
  const match = /request-script\.js(?::(\d+))?(?::(\d+))?/u.exec(value.stack);
  if (match === null) return {};
  return {
    line: match[1] === undefined ? 1 : Number(match[1]),
    ...(match[2] === undefined ? {} : { column: Number(match[2]) }),
  };
}

/** Maps a QuickJS exception to the stable, host-safe failure vocabulary. */
function sanitizeGuestFailure(value: unknown): WorkerFailure {
  const detail =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const name = typeof detail.name === "string" ? detail.name : "Error";
  const rawMessage =
    typeof detail.message === "string" ? detail.message : "Script failed";
  const knownCodes = new Set([
    "sdk_invalid_argument",
    "sdk_permission_denied",
    "sensitive_value_unavailable",
    "response_body_unavailable",
    "output_limit_exceeded",
  ]);
  let code =
    typeof detail.code === "string" && knownCodes.has(detail.code)
      ? detail.code
      : name === "SyntaxError"
        ? "syntax_error"
        : "runtime_error";
  if (rawMessage.toLowerCase().includes("interrupted")) {
    code = "time_limit_exceeded";
  } else if (rawMessage.toLowerCase().includes("out of memory")) {
    code = "memory_limit_exceeded";
  }
  const message =
    code === "time_limit_exceeded"
      ? "Script exceeded its execution-time limit"
      : code === "memory_limit_exceeded"
        ? "Script exceeded its memory limit"
        : rawMessage.slice(0, 1000);
  return {
    code,
    message,
    ...sourceLocation(detail),
  };
}

/** Emits exactly one result over the private IPC channel. */
async function writeResponse(value: unknown): Promise<void> {
  await new Promise<void>((resolve) => {
    if (process.send === undefined) {
      resolve();
      return;
    }
    process.send(value, undefined, undefined, () => resolve());
  });
  process.disconnect();
}

/** Loads the build-appropriate bootstrap module beside this worker. */
async function loadBootstrap(): Promise<string> {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const moduleName = `./script-sdk-bootstrap.${extension}`;
  const module = (await import(moduleName)) as {
    readonly SCRIPT_SDK_BOOTSTRAP: string;
  };
  return module.SCRIPT_SDK_BOOTSTRAP;
}

/** Runs one invocation in a fresh QuickJS runtime and context. */
async function execute(invocation: WorkerInvocation): Promise<unknown> {
  const quickJs = await getQuickJS();
  const runtime = quickJs.newRuntime();
  runtime.setMemoryLimit(invocation.limits.memoryBytes);
  runtime.setMaxStackSize(
    Math.min(524_288, Math.max(65_536, invocation.limits.memoryBytes / 8)),
  );
  const deadline = Date.now() + invocation.limits.wallTimeMilliseconds;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const context = runtime.newContext();
  try {
    const bootstrap = await loadBootstrap();
    const setup = context.evalCode(
      `${bootstrap}(${JSON.stringify(invocation)})`,
      "asdk-bootstrap.js",
      { type: "global" },
    );
    if (isFail(setup)) {
      const failure = sanitizeGuestFailure(context.dump(setup.error));
      setup.error.dispose();
      throw new WorkerScriptError(failure);
    }
    const bridge = setup.value;
    try {
      const sdk = context.getProp(bridge, "sdk");
      try {
        context.setProp(context.global, "asdk", sdk);
      } finally {
        sdk.dispose();
      }

      const evaluated = context.evalCode(
        `${invocation.source}\n;undefined;`,
        "request-script.js",
        { type: "global" },
      );
      if (isFail(evaluated)) {
        let failure = sanitizeGuestFailure(context.dump(evaluated.error));
        evaluated.error.dispose();
        const redactText = context.getProp(bridge, "redactText");
        try {
          const message = context.newString(failure.message);
          try {
            const redacted = context.callFunction(
              redactText,
              context.undefined,
              [message],
            );
            if (isFail(redacted)) {
              redacted.error.dispose();
            } else {
              const redactedMessage: unknown = context.dump(redacted.value);
              redacted.value.dispose();
              if (typeof redactedMessage === "string") {
                failure = { ...failure, message: redactedMessage };
              }
            }
          } finally {
            message.dispose();
          }
        } finally {
          redactText.dispose();
        }
        throw new WorkerScriptError(failure);
      }
      evaluated.value.dispose();

      const exportResult = context.getProp(bridge, "exportResult");
      try {
        const exported = context.callFunction(
          exportResult,
          context.undefined,
          [],
        );
        if (isFail(exported)) {
          const failure = sanitizeGuestFailure(context.dump(exported.error));
          exported.error.dispose();
          throw new WorkerScriptError(failure);
        }
        const dumped: unknown = exported.value.consume((value) => {
          const result: unknown = context.dump(value);
          return result;
        });
        return dumped;
      } finally {
        exportResult.dispose();
      }
    } finally {
      bridge.dispose();
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

/** Owns worker protocol termination without leaking native failures. */
async function main(): Promise<void> {
  try {
    const invocation = await readInvocation();
    const result = await execute(invocation);
    await writeResponse({ ok: true, result });
  } catch (cause) {
    const failure: WorkerFailure =
      cause instanceof WorkerScriptError
        ? {
            code: cause.code,
            message: cause.message,
            ...(cause.line === undefined ? {} : { line: cause.line }),
            ...(cause.column === undefined ? {} : { column: cause.column }),
          }
        : {
            code: "runtime_error",
            message: "The isolated script worker failed",
          };
    await writeResponse({ ok: false, error: failure });
  }
}

await main();
