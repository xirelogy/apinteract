import { readFile } from "node:fs/promises";

import { parse } from "yaml";

export interface ProxyPrincipalConfiguration {
  readonly id: string;
  readonly bearerToken: string;
}

export interface ProxyConfiguration {
  readonly configVersion: 1;
  readonly server: {
    readonly host: string;
    readonly port: number;
  };
  readonly cache: {
    readonly path: string;
    readonly retentionMs: number;
  };
  readonly principals: readonly ProxyPrincipalConfiguration[];
}

/** Requires a proxy configuration value to be a non-array object. */
function requireRecord(
  value: unknown,
  location: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Requires a non-empty proxy configuration string. */
function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

/** Requires a valid TCP port number. */
function requirePort(value: unknown, location: string): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 65535
  ) {
    throw new Error(`${location} must be an integer from 1 through 65535`);
  }
  return value as number;
}

/**
 * Loads and validates the proxy's complete strict-YAML configuration.
 *
 * Defaults apply only to documented optional fields. Bearer credentials are
 * read from this file and are not overridden by process environment variables.
 */
export async function loadProxyConfiguration(
  path: string,
): Promise<ProxyConfiguration> {
  const document = requireRecord(parse(await readFile(path, "utf8")), "config");
  if (document.configVersion !== 1) {
    throw new Error("config.configVersion must be 1");
  }

  const server = requireRecord(document.server ?? {}, "config.server");
  const cache = requireRecord(document.cache ?? {}, "config.cache");
  const rawPrincipals = document.principals;
  if (!Array.isArray(rawPrincipals) || rawPrincipals.length === 0) {
    throw new Error("config.principals must contain at least one principal");
  }

  const principals = rawPrincipals.map((value, index) => {
    const principal = requireRecord(value, `config.principals[${index}]`);
    return {
      id: requireString(principal.id, `config.principals[${index}].id`),
      bearerToken: requireString(
        principal.bearerToken,
        `config.principals[${index}].bearerToken`,
      ),
    };
  });

  return {
    configVersion: 1,
    server: {
      host:
        server.host === undefined
          ? "127.0.0.1"
          : requireString(server.host, "config.server.host"),
      port:
        server.port === undefined
          ? 8081
          : requirePort(server.port, "config.server.port"),
    },
    cache: {
      path:
        cache.path === undefined
          ? "/cache"
          : requireString(cache.path, "config.cache.path"),
      retentionMs: 15 * 60 * 1000,
    },
    principals,
  };
}
