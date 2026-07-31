import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

process.env.APINTERACT_BACKEND_PACKAGE_PATH = resolve(
  import.meta.dirname,
  "../../../apps/backend/package.json",
);
const { mergeRecords, prepareRuntime } = await import("./prepare-runtime.mjs");

test("merges administrator settings while retaining nested defaults", () => {
  assert.deepEqual(
    mergeRecords(
      { server: { host: "default", port: 8080 }, values: ["default"] },
      { server: { host: "custom" }, values: ["custom"] },
    ),
    { server: { host: "custom", port: 8080 }, values: ["custom"] },
  );
});

test("generates matching private AIO component credentials", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "apinteract-aio-runtime-"));
  const administratorRoot = resolve(root, "configuration");
  const runtimeRoot = resolve(root, "runtime");
  await mkdir(administratorRoot);
  await writeFile(
    resolve(administratorRoot, "backend.yaml"),
    JSON.stringify({
      configVersion: 1,
      server: { publicOrigin: "https://api.example.test" },
      sessions: { accessLifetimeSeconds: 300 },
      proxy: { bearerToken: "administrator-token-must-not-survive" },
    }),
  );
  await writeFile(
    resolve(administratorRoot, "proxy.yaml"),
    JSON.stringify({
      configVersion: 1,
      server: { host: "0.0.0.0", port: 9000 },
      principals: [{ id: "untrusted", bearerToken: "untrusted" }],
    }),
  );

  const prepared = await prepareRuntime({
    administratorRoot,
    runtimeRoot,
    dataRoot: resolve(root, "data"),
    cacheRoot: resolve(root, "cache"),
    frontendRoot: "/test/frontend",
    environment: {
      APINTERACT_AIO_PUBLIC_ORIGIN: "http://localhost:9980",
    },
    tokenFactory: () => Buffer.alloc(48, 7),
  });

  assert.equal(prepared.backend.server.host, "0.0.0.0");
  assert.equal(prepared.backend.server.port, 8080);
  assert.equal(
    prepared.backend.server.publicOrigin,
    "https://api.example.test",
  );
  assert.equal(prepared.backend.sessions.secureCookie, true);
  assert.equal(prepared.backend.sessions.accessLifetimeSeconds, 300);
  assert.equal(prepared.backend.frontend.distPath, "/test/frontend");
  assert.equal(prepared.backend.proxy.endpoint, "http://127.0.0.1:8081");
  assert.equal(prepared.proxy.server.host, "127.0.0.1");
  assert.equal(prepared.proxy.server.port, 8081);
  assert.equal(prepared.proxy.principals[0].id, "aio-backend");
  assert.equal(
    prepared.proxy.principals[0].bearerToken,
    prepared.backend.proxy.bearerToken,
  );
  assert.equal(
    (await readFile(resolve(runtimeRoot, "proxy-bearer-token"), "utf8")).trim(),
    prepared.bearerToken,
  );
  for (const name of ["proxy-bearer-token", "backend.yaml", "proxy.yaml"]) {
    expectPrivateMode(await stat(resolve(runtimeRoot, name)));
  }
  const repeated = await prepareRuntime({
    administratorRoot,
    runtimeRoot,
    dataRoot: resolve(root, "data"),
    cacheRoot: resolve(root, "cache"),
    frontendRoot: "/test/frontend",
    tokenFactory: () => Buffer.alloc(48, 9),
  });
  assert.equal(repeated.bearerToken, prepared.bearerToken);
});

test("uses the published local origin unless an administrator overrides it", async () => {
  const root = await mkdtemp(
    resolve(tmpdir(), "apinteract-aio-default-origin-"),
  );
  const administratorRoot = resolve(root, "configuration");
  await mkdir(administratorRoot);

  const prepared = await prepareRuntime({
    administratorRoot,
    runtimeRoot: resolve(root, "runtime"),
    dataRoot: resolve(root, "data"),
    cacheRoot: resolve(root, "cache"),
    environment: {
      APINTERACT_AIO_PUBLIC_ORIGIN: "http://localhost:9980",
    },
    tokenFactory: () => Buffer.alloc(48, 7),
  });

  assert.equal(prepared.backend.server.publicOrigin, "http://localhost:9980");
  assert.equal(prepared.backend.sessions.secureCookie, false);
});

/** Requires a generated runtime file to remain readable only by its owner. */
function expectPrivateMode(metadata) {
  assert.equal(metadata.mode & 0o777, 0o600);
}

test("rejects a non-loopback cleartext public origin", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "apinteract-aio-origin-"));
  const administratorRoot = resolve(root, "configuration");
  await mkdir(administratorRoot);
  await writeFile(
    resolve(administratorRoot, "backend.yaml"),
    JSON.stringify({
      configVersion: 1,
      server: { publicOrigin: "http://api.example.test" },
    }),
  );
  await assert.rejects(
    prepareRuntime({
      administratorRoot,
      runtimeRoot: resolve(root, "runtime"),
      dataRoot: resolve(root, "data"),
      cacheRoot: resolve(root, "cache"),
      tokenFactory: () => Buffer.alloc(48, 7),
    }),
    /must use HTTPS unless it is loopback-local/u,
  );
});

test("rejects unsupported administrator properties", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "apinteract-aio-unknown-"));
  const administratorRoot = resolve(root, "configuration");
  await mkdir(administratorRoot);
  await writeFile(
    resolve(administratorRoot, "backend.yaml"),
    JSON.stringify({ configVersion: 1, unsupported: "secret-value" }),
  );
  await assert.rejects(
    prepareRuntime({
      administratorRoot,
      runtimeRoot: resolve(root, "runtime"),
      dataRoot: resolve(root, "data"),
      cacheRoot: resolve(root, "cache"),
      tokenFactory: () => Buffer.alloc(48, 7),
    }),
    /config\.unsupported is not supported/u,
  );
});
