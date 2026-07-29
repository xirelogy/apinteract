import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const runtimeRoot = await mkdtemp(
  resolve(tmpdir(), "apinteract-browser-test-"),
);
const configurationRoot = resolve(runtimeRoot, "config");
const backendConfigurationPath = resolve(configurationRoot, "backend.yaml");
const proxyConfigurationPath = resolve(configurationRoot, "proxy.yaml");
const backendPort = Number.parseInt(
  process.env.APINTERACT_BROWSER_TEST_BACKEND_PORT ?? "8080",
  10,
);
const children = [];
let stopping = false;

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

try {
  await prepareRuntime();
  await initializeAdministrator();

  startProcess("fixture", ["exec", "node", "tooling/run-http-fixture.mjs"]);
  await waitForUrl("http://127.0.0.1:8090/hello");

  startProcess("proxy", [
    "--filter",
    "@apinteract/proxy",
    "exec",
    "tsx",
    "src/main.ts",
    "--config",
    proxyConfigurationPath,
  ]);
  await waitForUrl("http://127.0.0.1:8081/health");

  startProcess("backend", [
    "--filter",
    "@apinteract/backend",
    "exec",
    "tsx",
    "src/main.ts",
    "--config",
    backendConfigurationPath,
  ]);
  await waitForUrl(`http://127.0.0.1:${backendPort}/health`);

  startProcess("frontend", [
    "--filter",
    "@apinteract/frontend",
    "exec",
    "vite",
    "--host",
    "127.0.0.1",
    "--port",
    "5173",
    "--strictPort",
  ]);
  await waitForUrl("http://127.0.0.1:5173/web-ui/");
} catch (cause) {
  await stop(1);
  throw cause;
}

/** Creates isolated component state and strict YAML configuration files. */
async function prepareRuntime() {
  await Promise.all([
    mkdir(configurationRoot, { recursive: true }),
    mkdir(resolve(runtimeRoot, "audit"), { recursive: true }),
    mkdir(resolve(runtimeRoot, "backups"), { recursive: true }),
    mkdir(resolve(runtimeRoot, "blobs"), { recursive: true }),
    mkdir(resolve(runtimeRoot, "blob-staging"), { recursive: true }),
    mkdir(resolve(runtimeRoot, "proxy-cache"), { recursive: true }),
  ]);

  await Promise.all([
    writeFile(
      proxyConfigurationPath,
      serializeConfiguration({
        configVersion: 1,
        server: { host: "127.0.0.1", port: 8081 },
        cache: { path: resolve(runtimeRoot, "proxy-cache") },
        principals: [
          {
            id: "browser-test-backend",
            bearerToken: "browser-test-proxy-token",
          },
        ],
      }),
      { encoding: "utf8", mode: 0o600 },
    ),
    writeFile(
      backendConfigurationPath,
      serializeConfiguration({
        configVersion: 1,
        server: {
          host: "127.0.0.1",
          port: backendPort,
          publicOrigin: "http://127.0.0.1:5173",
        },
        persistence: {
          databasePath: resolve(runtimeRoot, "apinteract.sqlite3"),
          migrationBackupDirectory: resolve(runtimeRoot, "backups"),
        },
        blobs: {
          rootPath: resolve(runtimeRoot, "blobs"),
          stagingPath: resolve(runtimeRoot, "blob-staging"),
        },
        audit: { rootPath: resolve(runtimeRoot, "audit") },
        proxy: {
          endpoint: "http://127.0.0.1:8081",
          bearerToken: "browser-test-proxy-token",
        },
        sessions: { secureCookie: false },
        frontend: { distPath: resolve(runtimeRoot, "missing-frontend-dist") },
      }),
      { encoding: "utf8", mode: 0o600 },
    ),
  ]);
}

/** Serializes JSON-compatible values as strict YAML 1.2 configuration. */
function serializeConfiguration(configuration) {
  return JSON.stringify(configuration, null, 2) + "\n";
}

/** Creates the single administrator used by browser authentication tests. */
async function initializeAdministrator() {
  await runProcess(
    "administrator initialization",
    [
      "--filter",
      "@apinteract/backend",
      "exec",
      "tsx",
      "src/cli.ts",
      "admin",
      "init",
      "--username",
      "admin",
      "--display-name",
      "Administrator",
      "--config",
      backendConfigurationPath,
    ],
    "Browser-test-password-1!\n",
  );
}

/** Starts one long-running component and treats an early exit as fatal. */
function startProcess(name, arguments_) {
  const child = spawn("pnpm", arguments_, {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  children.push(child);
  child.once("error", (cause) => {
    if (!stopping) {
      process.stderr.write(`${name} could not start: ${cause.message}\n`);
      void stop(1);
    }
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      process.stderr.write(
        `${name} stopped unexpectedly (${signal ?? `exit ${code ?? 1}`}).\n`,
      );
      void stop(code ?? 1);
    }
  });
}

/** Runs one finite pnpm command and supplies optional standard input. */
async function runProcess(name, arguments_, input) {
  const child = spawn("pnpm", arguments_, {
    cwd: repositoryRoot,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (input !== undefined) {
    child.stdin.end(input);
  } else {
    child.stdin.end();
  }
  const code = await new Promise((resolvePromise) => {
    child.once("exit", (exitCode) => resolvePromise(exitCode ?? 1));
  });
  if (code !== 0) {
    throw new Error(`${name} failed with exit code ${code}`);
  }
}

/** Polls a readiness URL until it succeeds or the startup deadline expires. */
async function waitForUrl(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (stopping) {
      throw new Error(`Startup stopped while waiting for ${url}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Components are expected to refuse connections while still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** Stops every component and removes all disposable browser-test state. */
async function stop(exitCode = 0) {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  await Promise.all(children.map(waitForProcessExit));
  await rm(runtimeRoot, { recursive: true, force: true });
  process.exitCode = exitCode;
}

/** Waits for a child to exit and escalates to SIGKILL after five seconds. */
async function waitForProcessExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolvePromise) => {
    child.once("exit", resolvePromise);
    setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise();
    }, 5000).unref();
  });
}
