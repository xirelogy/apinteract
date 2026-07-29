import { readFile } from "node:fs/promises";

import { parse } from "yaml";

export interface BackendConfiguration {
  readonly configVersion: 1;
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly publicOrigin: string;
  };
  readonly persistence: {
    readonly databasePath: string;
    readonly migrationBackupDirectory: string;
  };
  readonly blobs: {
    readonly rootPath: string;
    readonly stagingPath: string;
  };
  readonly audit: {
    readonly rootPath: string;
  };
  readonly proxy: {
    readonly endpoint: string;
    readonly bearerToken: string;
  };
  readonly sessions: {
    readonly secureCookie: boolean;
    readonly accessLifetimeSeconds: number;
    readonly refreshIdleLifetimeSeconds: number;
    readonly refreshAbsoluteLifetimeSeconds: number;
  };
  readonly frontend: {
    readonly distPath: string;
  };
}

/** Requires a configuration value to be a non-array object. */
function record(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Reads a non-empty string or applies its documented default. */
function text(value: unknown, location: string, defaultValue?: string): string {
  if (value === undefined && defaultValue !== undefined) {
    return defaultValue;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

/** Reads a positive safe integer or applies its documented default. */
function integer(
  value: unknown,
  location: string,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${location} must be a positive safe integer`);
  }
  return value as number;
}

/**
 * Loads the backend's complete strict-YAML configuration.
 *
 * Missing optional fields receive documented defaults. Configuration is
 * sourced only from this file; process environment variables do not override
 * parsed values.
 */
export async function loadBackendConfiguration(
  path: string,
): Promise<BackendConfiguration> {
  const document = record(parse(await readFile(path, "utf8")), "config");
  if (document.configVersion !== 1) {
    throw new Error("config.configVersion must be 1");
  }
  const server = record(document.server ?? {}, "config.server");
  const persistence = record(document.persistence ?? {}, "config.persistence");
  const blobs = record(document.blobs ?? {}, "config.blobs");
  const audit = record(document.audit ?? {}, "config.audit");
  const proxy = record(document.proxy, "config.proxy");
  const sessions = record(document.sessions ?? {}, "config.sessions");
  const frontend = record(document.frontend ?? {}, "config.frontend");

  const secureCookie =
    sessions.secureCookie === undefined ? true : sessions.secureCookie;
  if (typeof secureCookie !== "boolean") {
    throw new Error("config.sessions.secureCookie must be a boolean");
  }

  return {
    configVersion: 1,
    server: {
      host: text(server.host, "config.server.host", "0.0.0.0"),
      port: integer(server.port, "config.server.port", 8080),
      publicOrigin: text(
        server.publicOrigin,
        "config.server.publicOrigin",
        "http://localhost:8080",
      ),
    },
    persistence: {
      databasePath: text(
        persistence.databasePath,
        "config.persistence.databasePath",
        "/data/apinteract.sqlite3",
      ),
      migrationBackupDirectory: text(
        persistence.migrationBackupDirectory,
        "config.persistence.migrationBackupDirectory",
        "/data/backups",
      ),
    },
    blobs: {
      rootPath: text(blobs.rootPath, "config.blobs.rootPath", "/data/blobs"),
      stagingPath: text(
        blobs.stagingPath,
        "config.blobs.stagingPath",
        "/data/blob-staging",
      ),
    },
    audit: {
      rootPath: text(audit.rootPath, "config.audit.rootPath", "/data/audit"),
    },
    proxy: {
      endpoint: text(proxy.endpoint, "config.proxy.endpoint"),
      bearerToken: text(proxy.bearerToken, "config.proxy.bearerToken"),
    },
    sessions: {
      secureCookie,
      accessLifetimeSeconds: integer(
        sessions.accessLifetimeSeconds,
        "config.sessions.accessLifetimeSeconds",
        15 * 60,
      ),
      refreshIdleLifetimeSeconds: integer(
        sessions.refreshIdleLifetimeSeconds,
        "config.sessions.refreshIdleLifetimeSeconds",
        7 * 24 * 60 * 60,
      ),
      refreshAbsoluteLifetimeSeconds: integer(
        sessions.refreshAbsoluteLifetimeSeconds,
        "config.sessions.refreshAbsoluteLifetimeSeconds",
        30 * 24 * 60 * 60,
      ),
    },
    frontend: {
      distPath: text(
        frontend.distPath,
        "config.frontend.distPath",
        "/opt/apinteract/frontend",
      ),
    },
  };
}
