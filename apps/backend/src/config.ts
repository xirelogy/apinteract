import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import type { AuthProviderValue } from "@apinteract/plugin-api/backend/authentication";

import {
  DEFAULT_SCRIPT_VARIABLE_WRITE_POLICY,
  SCRIPT_VARIABLE_WRITE_SCOPES,
  type ScriptVariableWritePolicy,
  type ScriptVariableWriteScope,
} from "./scripting/script-types.js";

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
  readonly authentication?: {
    readonly providers: readonly AuthenticationProviderConfiguration[];
  };
  readonly plugins?: {
    readonly builtinPath: string;
    readonly userPath: string;
  };
  readonly scripts?: {
    readonly variableWrites: ScriptVariableWritePolicy;
  };
}

/** Selects and presents one startup-configured authentication provider. */
export interface AuthenticationProviderConfiguration {
  readonly id: string;
  readonly plugin: string;
  readonly label: string;
  readonly description?: string;
  readonly configuration: AuthProviderValue;
}

const identifierPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const MAX_AUTH_CONFIGURATION_DEPTH = 8;
const MAX_AUTH_CONFIGURATION_ITEMS = 128;
const MAX_AUTH_CONFIGURATION_STRING = 4096;

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

/** Reads a boolean or applies its documented default. */
function boolean(
  value: unknown,
  location: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    throw new Error(`${location} must be a boolean`);
  }
  return value;
}

/** Converts one bounded YAML subtree into a JSON-compatible provider value. */
function authConfigurationValue(
  value: unknown,
  location: string,
  depth = 0,
): AuthProviderValue {
  if (depth > MAX_AUTH_CONFIGURATION_DEPTH) {
    throw new Error(`${location} exceeds the maximum nesting depth`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    if (value.length > MAX_AUTH_CONFIGURATION_STRING) {
      throw new Error(`${location} exceeds the maximum string length`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_AUTH_CONFIGURATION_ITEMS) {
      throw new Error(`${location} contains too many items`);
    }
    return value.map((item, index) =>
      authConfigurationValue(item, `${location}[${index}]`, depth + 1),
    );
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length > MAX_AUTH_CONFIGURATION_ITEMS) {
      throw new Error(`${location} contains too many properties`);
    }
    return Object.fromEntries(
      entries.map(([key, item]) => {
        if (key.length === 0 || key.length > 100) {
          throw new Error(`${location} contains an invalid property name`);
        }
        return [
          key,
          authConfigurationValue(item, `${location}.${key}`, depth + 1),
        ];
      }),
    );
  }
  throw new Error(`${location} must contain only JSON-compatible values`);
}

/** Parses the ordered provider-instance allowlist or its documented default. */
function authenticationProviders(
  value: unknown,
): readonly AuthenticationProviderConfiguration[] {
  if (value === undefined) {
    return [
      {
        id: "local-password",
        plugin: "builtin.local-password",
        label: "Username and password",
        description: "Sign in with your APInteract username and password.",
        configuration: {},
      },
    ];
  }
  const authentication = record(value, "config.authentication");
  if (
    !Array.isArray(authentication.providers) ||
    authentication.providers.length === 0
  ) {
    throw new Error(
      "config.authentication.providers must be a non-empty array",
    );
  }
  const identifiers = new Set<string>();
  return authentication.providers.map((entry, index) => {
    const location = `config.authentication.providers[${index}]`;
    const provider = record(entry, location);
    const id = text(provider.id, `${location}.id`);
    const plugin = text(provider.plugin, `${location}.plugin`);
    if (
      id.length > 128 ||
      plugin.length > 128 ||
      !identifierPattern.test(id) ||
      !identifierPattern.test(plugin)
    ) {
      throw new Error(`${location} has an invalid id or plugin`);
    }
    if (identifiers.has(id)) {
      throw new Error(`config.authentication.providers has duplicate id ${id}`);
    }
    identifiers.add(id);
    const description =
      provider.description === undefined
        ? undefined
        : text(provider.description, `${location}.description`);
    const label = text(provider.label, `${location}.label`);
    if (label.length > 200 || (description?.length ?? 0) > 1000) {
      throw new Error(`${location} has an overlong label or description`);
    }
    return {
      id,
      plugin,
      label,
      ...(description === undefined ? {} : { description }),
      configuration: authConfigurationValue(
        provider.configuration ?? {},
        `${location}.configuration`,
      ),
    };
  });
}

/** Reads the unique allowlisted scopes accepted by script variable setters. */
function variableWriteScopes(
  value: unknown,
): readonly ScriptVariableWriteScope[] {
  if (value === undefined) {
    return DEFAULT_SCRIPT_VARIABLE_WRITE_POLICY.allowedScopes;
  }
  if (!Array.isArray(value)) {
    throw new Error(
      "config.scripts.variableWrites.allowedScopes must be an array",
    );
  }
  const allowed = new Set<string>(SCRIPT_VARIABLE_WRITE_SCOPES);
  const scopes = value.map((scope) => {
    if (typeof scope !== "string" || !allowed.has(scope)) {
      throw new Error(
        "config.scripts.variableWrites.allowedScopes contains an unsupported scope",
      );
    }
    return scope as ScriptVariableWriteScope;
  });
  if (new Set(scopes).size !== scopes.length) {
    throw new Error(
      "config.scripts.variableWrites.allowedScopes must not contain duplicates",
    );
  }
  return scopes;
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
  const plugins = record(document.plugins ?? {}, "config.plugins");
  const scripts = record(document.scripts ?? {}, "config.scripts");
  const variableWrites = record(
    scripts.variableWrites ?? {},
    "config.scripts.variableWrites",
  );
  const authentication = authenticationProviders(document.authentication);

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
    authentication: { providers: authentication },
    plugins: {
      builtinPath: text(
        plugins.builtinPath,
        "config.plugins.builtinPath",
        "/opt/apinteract/plugins",
      ),
      userPath: text(
        plugins.userPath,
        "config.plugins.userPath",
        "/data/plugins",
      ),
    },
    scripts: {
      variableWrites: {
        allowedScopes: variableWriteScopes(variableWrites.allowedScopes),
        allowSecrets: boolean(
          variableWrites.allowSecrets,
          "config.scripts.variableWrites.allowSecrets",
          DEFAULT_SCRIPT_VARIABLE_WRITE_POLICY.allowSecrets,
        ),
      },
    },
  };
}
