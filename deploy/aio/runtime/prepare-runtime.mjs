import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const requireFromBackend = createRequire(
  process.env.APINTERACT_BACKEND_PACKAGE_PATH ??
    "/opt/apinteract/backend/package.json",
);
const { parse } = requireFromBackend("yaml");

const GENERATED_PRINCIPAL_ID = "aio-backend";
const GENERATED_TOKEN_BYTES = 48;

/** Packaged backend defaults for the all-in-one deployment. */
export const DEFAULT_BACKEND_CONFIGURATION = Object.freeze({
  configVersion: 1,
  server: {
    host: "0.0.0.0",
    port: 8080,
    publicOrigin: "http://localhost:8080",
  },
  persistence: {
    databasePath: "/data/database/apinteract.sqlite3",
    migrationBackupDirectory: "/data/backups",
  },
  blobs: {
    rootPath: "/data/blobs",
    stagingPath: "/data/blob-staging",
  },
  audit: {
    rootPath: "/data/audit",
  },
  sessions: {
    secureCookie: false,
  },
});

/** Packaged proxy defaults for the loopback-only all-in-one data plane. */
export const DEFAULT_PROXY_CONFIGURATION = Object.freeze({
  configVersion: 1,
  server: {
    host: "127.0.0.1",
    port: 8081,
  },
  cache: {
    path: "/cache",
    retentionMs: 15 * 60 * 1000,
  },
  limits: {
    maxMetadataBytes: 1_048_576,
    maxRequestHeaderCount: 1_024,
    maxRequestBodyBytes: 786_432,
    maxResponseBodyBytes: 1_073_741_824,
    maxCacheBytesPerPrincipal: 2_147_483_648,
    maxConcurrentExecutionsPerPrincipal: 16,
  },
  targetPolicy: {
    privateNetworkAccess: "deny",
    allowCidrs: [],
    denyCidrs: [],
  },
});

/**
 * Creates effective component configuration and one shared local credential.
 *
 * Administrator configuration is merged over packaged defaults. AIO-owned
 * listener, frontend, and proxy-authentication fields are then enforced so an
 * administrator file cannot expose the local proxy or replace its principal.
 */
export async function prepareRuntime(options = {}) {
  const administratorRoot = options.administratorRoot ?? "/etc/apinteract";
  const runtimeRoot = options.runtimeRoot ?? "/run/apinteract";
  const dataRoot = options.dataRoot ?? "/data";
  const cacheRoot = options.cacheRoot ?? "/cache";
  const frontendRoot = options.frontendRoot ?? "/opt/apinteract/frontend";
  const defaultPublicOrigin =
    (options.environment ?? process.env).APINTERACT_AIO_PUBLIC_ORIGIN ??
    DEFAULT_BACKEND_CONFIGURATION.server.publicOrigin;
  const tokenFactory =
    options.tokenFactory ?? (() => randomBytes(GENERATED_TOKEN_BYTES));

  await createRuntimeDirectories(runtimeRoot, dataRoot, cacheRoot);
  const [administratorBackend, administratorProxy, bearerToken] =
    await Promise.all([
      readOptionalConfiguration(
        resolve(administratorRoot, "backend.yaml"),
        validateBackendConfigurationKeys,
      ),
      readOptionalConfiguration(
        resolve(administratorRoot, "proxy.yaml"),
        validateProxyConfigurationKeys,
      ),
      loadOrCreateBearerToken(runtimeRoot, tokenFactory),
    ]);

  const backend = mergeRecords(
    mergeRecords(DEFAULT_BACKEND_CONFIGURATION, {
      server: { publicOrigin: defaultPublicOrigin },
      persistence: {
        databasePath: resolve(dataRoot, "database", "apinteract.sqlite3"),
        migrationBackupDirectory: resolve(dataRoot, "backups"),
      },
      blobs: {
        rootPath: resolve(dataRoot, "blobs"),
        stagingPath: resolve(dataRoot, "blob-staging"),
      },
      audit: { rootPath: resolve(dataRoot, "audit") },
    }),
    administratorBackend,
  );
  const publicOrigin = validatePublicOrigin(backend.server?.publicOrigin);
  const effectiveBackend = {
    ...backend,
    configVersion: 1,
    server: {
      ...recordOrEmpty(backend.server, "config.server"),
      host: "0.0.0.0",
      port: 8080,
      publicOrigin,
    },
    proxy: {
      endpoint: "http://127.0.0.1:8081",
      bearerToken,
    },
    sessions: {
      ...recordOrEmpty(backend.sessions, "config.sessions"),
      secureCookie: publicOrigin.startsWith("https:"),
    },
    frontend: {
      distPath: frontendRoot,
    },
  };

  const proxy = mergeRecords(
    mergeRecords(DEFAULT_PROXY_CONFIGURATION, {
      cache: { path: cacheRoot },
    }),
    administratorProxy,
  );
  const effectiveProxy = {
    ...proxy,
    configVersion: 1,
    server: {
      host: "127.0.0.1",
      port: 8081,
    },
    principals: [
      {
        id: GENERATED_PRINCIPAL_ID,
        bearerToken,
      },
    ],
  };

  await Promise.all([
    writePrivateJson(resolve(runtimeRoot, "backend.yaml"), effectiveBackend),
    writePrivateJson(resolve(runtimeRoot, "proxy.yaml"), effectiveProxy),
  ]);
  return {
    backend: effectiveBackend,
    proxy: effectiveProxy,
    bearerToken,
  };
}

/** Creates all durable and runtime-owned directories required before startup. */
async function createRuntimeDirectories(runtimeRoot, dataRoot, cacheRoot) {
  await Promise.all(
    [
      runtimeRoot,
      resolve(dataRoot, "database"),
      resolve(dataRoot, "blobs"),
      resolve(dataRoot, "blob-staging"),
      resolve(dataRoot, "backups"),
      resolve(dataRoot, "audit"),
      cacheRoot,
    ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
}

/** Reads one optional administrator YAML document as a plain object. */
async function readOptionalConfiguration(path, validateKeys) {
  try {
    const source = await readFile(path, "utf8");
    const value = parse(source, { maxAliasCount: 0, uniqueKeys: true });
    const configuration = requireRecord(value, "config");
    if (configuration.configVersion !== 1) {
      throw new Error(`${path}: config.configVersion must be 1`);
    }
    validateKeys(configuration);
    return configuration;
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      return {};
    }
    throw cause;
  }
}

/** Rejects administrator backend properties not supported by this release. */
function validateBackendConfigurationKeys(configuration) {
  requireKnownKeys(configuration, "config", [
    "configVersion",
    "server",
    "persistence",
    "blobs",
    "audit",
    "proxy",
    "sessions",
    "frontend",
  ]);
  requireKnownKeys(
    recordOrEmpty(configuration.server, "config.server"),
    "config.server",
    ["host", "port", "publicOrigin"],
  );
  requireKnownKeys(
    recordOrEmpty(configuration.persistence, "config.persistence"),
    "config.persistence",
    ["databasePath", "migrationBackupDirectory"],
  );
  requireKnownKeys(
    recordOrEmpty(configuration.blobs, "config.blobs"),
    "config.blobs",
    ["rootPath", "stagingPath"],
  );
  requireKnownKeys(
    recordOrEmpty(configuration.audit, "config.audit"),
    "config.audit",
    ["rootPath"],
  );
  requireKnownKeys(
    recordOrEmpty(configuration.proxy, "config.proxy"),
    "config.proxy",
    ["endpoint", "bearerToken"],
  );
  requireKnownKeys(
    recordOrEmpty(configuration.sessions, "config.sessions"),
    "config.sessions",
    [
      "secureCookie",
      "accessLifetimeSeconds",
      "refreshIdleLifetimeSeconds",
      "refreshAbsoluteLifetimeSeconds",
    ],
  );
  requireKnownKeys(
    recordOrEmpty(configuration.frontend, "config.frontend"),
    "config.frontend",
    ["distPath"],
  );
}

/** Rejects administrator proxy properties not supported by this release. */
function validateProxyConfigurationKeys(configuration) {
  requireKnownKeys(configuration, "config", [
    "configVersion",
    "server",
    "cache",
    "limits",
    "targetPolicy",
    "principals",
  ]);
  requireKnownKeys(
    recordOrEmpty(configuration.server, "config.server"),
    "config.server",
    ["host", "port"],
  );
  requireKnownKeys(
    recordOrEmpty(configuration.cache, "config.cache"),
    "config.cache",
    ["path", "retentionMs"],
  );
  requireKnownKeys(
    recordOrEmpty(configuration.limits, "config.limits"),
    "config.limits",
    [
      "maxMetadataBytes",
      "maxRequestHeaderCount",
      "maxRequestBodyBytes",
      "maxResponseBodyBytes",
      "maxCacheBytesPerPrincipal",
      "maxConcurrentExecutionsPerPrincipal",
    ],
  );
  requireKnownKeys(
    recordOrEmpty(configuration.targetPolicy, "config.targetPolicy"),
    "config.targetPolicy",
    ["privateNetworkAccess", "allowCidrs", "denyCidrs"],
  );
  if (configuration.principals !== undefined) {
    if (!Array.isArray(configuration.principals)) {
      throw new Error("config.principals must be an array");
    }
    configuration.principals.forEach((principal, index) =>
      requireKnownKeys(
        requireRecord(principal, `config.principals[${index}]`),
        `config.principals[${index}]`,
        ["id", "bearerToken"],
      ),
    );
  }
}

/** Rejects unknown properties without rendering potentially sensitive values. */
function requireKnownKeys(value, location, keys) {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new Error(`${location}.${unknown} is not supported`);
  }
}

/** Reuses a container-local token or creates it atomically with private mode. */
async function loadOrCreateBearerToken(runtimeRoot, tokenFactory) {
  const path = resolve(runtimeRoot, "proxy-bearer-token");
  try {
    const token = (await readFile(path, "utf8")).trim();
    if (token.length < 64) {
      throw new Error("Generated AIO proxy credential is invalid");
    }
    return token;
  } catch (cause) {
    if (cause?.code !== "ENOENT") {
      throw cause;
    }
  }

  const bytes = tokenFactory();
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 32) {
    throw new Error(
      "AIO proxy credential generation returned too little entropy",
    );
  }
  const token = bytes.toString("base64url");
  await writePrivateFile(path, `${token}\n`);
  return token;
}

/** Recursively merges object configuration while replacing arrays and scalars. */
export function mergeRecords(defaults, overrides) {
  const result = { ...requireRecord(defaults, "defaults") };
  for (const [key, value] of Object.entries(
    requireRecord(overrides, "overrides"),
  )) {
    const current = result[key];
    result[key] =
      isRecord(current) && isRecord(value)
        ? mergeRecords(current, value)
        : value;
  }
  return result;
}

/** Validates the one canonical external browser origin used by the backend. */
function validatePublicOrigin(value) {
  if (typeof value !== "string") {
    throw new Error("config.server.publicOrigin must be an HTTP origin");
  }
  const origin = new URL(value);
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.origin !== value
  ) {
    throw new Error(
      "config.server.publicOrigin must be an HTTP origin without a path",
    );
  }
  if (
    origin.protocol === "http:" &&
    origin.hostname !== "localhost" &&
    origin.hostname !== "127.0.0.1" &&
    origin.hostname !== "[::1]"
  ) {
    throw new Error(
      "config.server.publicOrigin must use HTTPS unless it is loopback-local",
    );
  }
  return value;
}

/** Returns an object configuration section or an empty section when omitted. */
function recordOrEmpty(value, location) {
  return value === undefined ? {} : requireRecord(value, location);
}

/** Requires a non-array object without exposing its contents on failure. */
function requireRecord(value, location) {
  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value;
}

/** Reports whether a value is a non-array object. */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Serializes JSON-compatible configuration using the YAML 1.2 JSON subset. */
async function writePrivateJson(path, value) {
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Replaces one private runtime file without exposing a partially written file. */
async function writePrivateFile(path, contents) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
  await stat(path);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await prepareRuntime();
}
