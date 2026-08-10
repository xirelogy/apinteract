import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fromWireRequest,
  isWorkerResponse,
  toScriptError,
  toWireRequest,
  toWireResponse,
  toWireVariable,
  validateLocal,
  validateLogs,
  validateTests,
  type WorkerSuccess,
} from "./script-protocol.js";
import {
  DEFAULT_SCRIPT_LIMITS,
  SCRIPT_SDK_VERSION,
  ScriptExecutionError,
  type CommonScriptInput,
  type PostResponseScriptInput,
  type PostResponseScriptResult,
  type PreRequestScriptInput,
  type PreRequestScriptResult,
  type ScriptLimits,
} from "./script-types.js";

const MAX_SCRIPT_LIMITS: ScriptLimits = {
  sourceBytes: 1_048_576,
  inputBytes: 16_777_216,
  outputBytes: 16_777_216,
  bodyBytes: 8_388_608,
  logEntries: 1000,
  logBytes: 1_048_576,
  localVariableCount: 1000,
  localVariableBytes: 1_048_576,
  wallTimeMilliseconds: 10_000,
  memoryBytes: 134_217_728,
};

const CHILD_STARTUP_GRACE_MS = 5000;
const CHILD_STDOUT_OVERHEAD_BYTES = 65_536;
const require = createRequire(import.meta.url);

/** Owns the isolated QuickJS workers used by backend request scripts. */
export class ScriptService {
  readonly #children = new Set<ChildProcess>();
  readonly #active = new Set<Promise<void>>();
  #accepting = true;

  /** Runs one pre-request script against a copied working request. */
  async runPreRequest(
    source: string,
    input: PreRequestScriptInput,
    signal?: AbortSignal,
  ): Promise<PreRequestScriptResult> {
    const started = Date.now();
    const result = await invokeSafely(
      () => this.#invoke("pre-request", source, input, signal),
      "pre-request",
    );
    if (result.request === undefined) {
      throw new ScriptExecutionError(
        "runtime_error",
        "Pre-request script returned no request",
      );
    }
    return {
      sdkVersion: SCRIPT_SDK_VERSION,
      request: fromWireRequest(result.request),
      local: validateLocal(result.local),
      logs: validateLogs(result.logs),
      durationMilliseconds: Date.now() - started,
    };
  }

  /** Runs one post-response script against a copied complete target response. */
  async runPostResponse(
    source: string,
    input: PostResponseScriptInput,
    signal?: AbortSignal,
  ): Promise<PostResponseScriptResult> {
    const started = Date.now();
    const result = await invokeSafely(
      () => this.#invoke("post-response", source, input, signal),
      "post-response",
    );
    return {
      sdkVersion: SCRIPT_SDK_VERSION,
      local: validateLocal(result.local),
      logs: validateLogs(result.logs),
      tests: validateTests(result.tests),
      durationMilliseconds: Date.now() - started,
    };
  }

  /** Stops accepting scripts and kills workers that are still executing. */
  async close(): Promise<void> {
    this.#accepting = false;
    for (const child of this.#children) child.kill("SIGKILL");
    await Promise.all([...this.#active]);
  }

  /** Invokes one worker and validates only its transport-level result. */
  async #invoke(
    phase: "pre-request" | "post-response",
    source: string,
    input: CommonScriptInput & Partial<PostResponseScriptInput>,
    signal?: AbortSignal,
  ): Promise<WorkerSuccess["result"]> {
    if (!this.#accepting) {
      throw new ScriptExecutionError(
        "cancelled",
        "Script execution is unavailable during shutdown",
      );
    }
    const limits = normalizeLimits(input.limits);
    const sourceBytes = Buffer.byteLength(source, "utf8");
    if (sourceBytes > limits.sourceBytes) {
      throw new ScriptExecutionError(
        "output_limit_exceeded",
        "Script source exceeds the configured source limit",
      );
    }
    const invocation = {
      phase,
      source,
      sdkVersion: SCRIPT_SDK_VERSION,
      execution: input.execution,
      limits,
      request: toWireRequest(input.request, phase),
      variables: input.variables.map(toWireVariable),
      ...(input.local === undefined ? {} : { local: input.local }),
      ...(phase === "post-response" && input.response !== undefined
        ? { response: toWireResponse(input.response, limits) }
        : {}),
    };
    const payload = JSON.stringify(invocation);
    if (Buffer.byteLength(payload, "utf8") > limits.inputBytes) {
      throw new ScriptExecutionError(
        "output_limit_exceeded",
        "Script input exceeds the configured input limit",
      );
    }

    const workerPath = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "./script-worker.ts"
          : "./script-worker.js",
        import.meta.url,
      ),
    );
    const nodeModulesRoot = findNodeModulesRoot(resolveQuickJsModule());
    const backendRoot = dirname(dirname(dirname(workerPath)));
    const memoryMegabytes = Math.max(
      64,
      Math.ceil(limits.memoryBytes / 1_048_576) * 2,
    );
    const child = fork(workerPath, [], {
      cwd: dirname(workerPath),
      env: { NODE_NO_WARNINGS: "1" },
      execArgv: [
        `--max-old-space-size=${memoryMegabytes}`,
        "--permission",
        `--allow-fs-read=${dirname(workerPath)}`,
        `--allow-fs-read=${join(backendRoot, "node_modules")}`,
        `--allow-fs-read=${join(backendRoot, "package.json")}`,
        `--allow-fs-read=${nodeModulesRoot}`,
        "--no-addons",
        "--disallow-code-generation-from-strings",
        "--unhandled-rejections=strict",
      ],
      serialization: "json",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.#children.add(child);
    let resolveActive: (() => void) | undefined;
    const active = new Promise<void>((resolve) => {
      resolveActive = resolve;
    });
    this.#active.add(active);

    try {
      return await new Promise<WorkerSuccess["result"]>((resolve, reject) => {
        let settled = false;
        let termination:
          | "cancelled"
          | "time_limit_exceeded"
          | "output_limit_exceeded"
          | undefined;
        let response: unknown;
        const diagnostics: Buffer[] = [];
        let diagnosticBytes = 0;
        const timeout = setTimeout(() => {
          termination = "time_limit_exceeded";
          child.kill("SIGKILL");
        }, limits.wallTimeMilliseconds + CHILD_STARTUP_GRACE_MS);
        /** Settles one invocation outcome and releases its timeout once. */
        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          callback();
        };
        /** Kills the isolated worker when the caller cancels execution. */
        const abort = (): void => {
          termination = "cancelled";
          child.kill("SIGKILL");
        };
        if (signal !== undefined) {
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }
        child.stdout?.resume();
        child.stderr?.on("data", (chunk: Buffer) => {
          if (diagnosticBytes >= 8192) return;
          diagnostics.push(chunk.subarray(0, 8192 - diagnosticBytes));
          diagnosticBytes += chunk.byteLength;
        });
        child.once("message", (value: unknown) => {
          const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
          if (bytes > limits.outputBytes + CHILD_STDOUT_OVERHEAD_BYTES) {
            termination = "output_limit_exceeded";
            child.kill("SIGKILL");
            return;
          }
          response = value;
        });
        child.once("error", () => {
          finish(() =>
            reject(
              new ScriptExecutionError(
                "runtime_error",
                "The isolated script worker could not be started",
              ),
            ),
          );
        });
        child.once("close", () => {
          if (signal !== undefined) signal.removeEventListener("abort", abort);
          finish(() => {
            if (termination !== undefined) {
              reject(
                new ScriptExecutionError(
                  termination,
                  termination === "cancelled"
                    ? "Script execution was cancelled"
                    : termination === "output_limit_exceeded"
                      ? "Script exceeded its output limit"
                      : "Script exceeded its execution-time limit",
                ),
              );
              return;
            }
            if (response === undefined) {
              reject(
                workerRuntimeError(
                  "The isolated script worker exited unexpectedly",
                  Buffer.concat(diagnostics).toString("utf8"),
                ),
              );
              return;
            }
            if (!isWorkerResponse(response)) {
              reject(
                new ScriptExecutionError(
                  "runtime_error",
                  "The isolated script worker returned an invalid result",
                ),
              );
              return;
            }
            if (!response.ok) {
              reject(toScriptError(response.error));
              return;
            }
            resolve(response.result);
          });
        });
        child.send(invocation, (error) => {
          if (error === null) return;
          finish(() =>
            reject(
              new ScriptExecutionError(
                "runtime_error",
                "The isolated script worker could not receive its input",
              ),
            ),
          );
          child.kill("SIGKILL");
        });
      });
    } finally {
      this.#children.delete(child);
      this.#active.delete(active);
      resolveActive?.();
    }
  }
}

/** Preserves sandbox diagnostics and normalizes host setup failures safely. */
async function invokeSafely<Result>(
  invoke: () => Promise<Result>,
  phase: "pre-request" | "post-response",
): Promise<Result> {
  try {
    return await invoke();
  } catch (cause) {
    if (cause instanceof ScriptExecutionError) throw cause;
    const error = new ScriptExecutionError(
      "runtime_error",
      `The isolated runtime could not start the ${phase} script`,
    );
    if (cause instanceof Error) {
      Object.defineProperty(error, "cause", {
        configurable: false,
        enumerable: false,
        value: cause,
        writable: false,
      });
    }
    throw error;
  }
}

/** Resolves the sandbox engine or reports the missing installation directly. */
function resolveQuickJsModule(): string {
  try {
    return require.resolve("quickjs-emscripten");
  } catch (cause) {
    const code =
      cause instanceof Error && "code" in cause
        ? (cause as NodeJS.ErrnoException).code
        : undefined;
    throw new ScriptExecutionError(
      "runtime_error",
      code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND"
        ? "The QuickJS script runtime is not installed; install backend dependencies and restart APInteract"
        : "The backend could not resolve the QuickJS script runtime",
    );
  }
}

/** Finds the workspace node_modules root allowed to the worker loader. */
function findNodeModulesRoot(modulePath: string): string {
  const marker = `${sep}node_modules${sep}`;
  const index = modulePath.indexOf(marker);
  if (index < 0) return dirname(modulePath);
  return modulePath.slice(0, index + marker.length - 1);
}

/** Attaches private worker diagnostics without changing the user-safe message. */
function workerRuntimeError(
  message: string,
  diagnostic: string,
): ScriptExecutionError {
  const publicMessage = diagnostic.includes("ERR_MODULE_NOT_FOUND")
    ? "The isolated script worker could not load its runtime dependencies; install backend dependencies and restart APInteract"
    : diagnostic.includes("ERR_ACCESS_DENIED")
      ? "The isolated script worker was blocked by the backend permission policy"
      : message;
  const error = new ScriptExecutionError("runtime_error", publicMessage);
  if (diagnostic.length > 0) {
    Object.defineProperty(error, "cause", {
      configurable: false,
      enumerable: false,
      value: new Error(diagnostic.slice(0, 8192)),
      writable: false,
    });
  }
  return error;
}

/** Merges caller limits with defaults and rejects unsafe or malformed values. */
function normalizeLimits(
  overrides: Partial<ScriptLimits> | undefined,
): ScriptLimits {
  const candidate = { ...DEFAULT_SCRIPT_LIMITS, ...(overrides ?? {}) };
  for (const key of Object.keys(
    DEFAULT_SCRIPT_LIMITS,
  ) as (keyof ScriptLimits)[]) {
    const value = candidate[key];
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > MAX_SCRIPT_LIMITS[key]
    ) {
      throw new ScriptExecutionError(
        "sdk_invalid_argument",
        `Script limit ${key} is outside the supported range`,
      );
    }
  }
  return candidate;
}
