import { readFile } from "node:fs/promises";
import { isIP } from "node:net";

import { parse } from "yaml";

/** Default enforceable limits reported by the proxy capability endpoint. */
export const DEFAULT_PROXY_LIMITS = Object.freeze({
  maxMetadataBytes: 1_048_576,
  maxRequestHeaderCount: 1_024,
  maxRequestBodyBytes: 786_432,
  maxResponseBodyBytes: 1_073_741_824,
  maxCacheBytesPerPrincipal: 2_147_483_648,
  maxConcurrentExecutionsPerPrincipal: 16,
});

/** Default terminal response-frame retention in milliseconds. */
export const DEFAULT_RESPONSE_CACHE_RETENTION_MS = 15 * 60 * 1_000;

const CONFIGURATION_CEILINGS = Object.freeze({
  maxMetadataBytes: 16 * 1_048_576,
  maxRequestHeaderCount: 1_024,
  maxRequestBodyBytes: 4_294_967_296,
  maxResponseBodyBytes: 4_294_967_296,
  maxCacheBytesPerPrincipal: 68_719_476_736,
  maxConcurrentExecutionsPerPrincipal: 1_024,
  retentionMs: 7 * 24 * 60 * 60 * 1_000,
});

export interface ProxyPrincipalConfiguration {
  readonly id: string;
  readonly bearerToken: string;
}

/** Effective per-principal ceilings enforced by the proxy runtime. */
export interface ProxyLimitsConfiguration {
  readonly maxMetadataBytes: number;
  readonly maxRequestHeaderCount: number;
  readonly maxRequestBodyBytes: number;
  readonly maxResponseBodyBytes: number;
  readonly maxCacheBytesPerPrincipal: number;
  readonly maxConcurrentExecutionsPerPrincipal: number;
}

/** Administrator policy controlling resolved outbound target addresses. */
export interface ProxyTargetPolicyConfiguration {
  readonly privateNetworkAccess: "allow" | "deny";
  readonly allowCidrs: readonly string[];
  readonly denyCidrs: readonly string[];
}

/** Complete validated configuration consumed by one proxy process. */
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
  readonly limits: ProxyLimitsConfiguration;
  readonly targetPolicy: ProxyTargetPolicyConfiguration;
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

/** Rejects unsupported properties without rendering their potentially sensitive values. */
function requireKnownKeys(
  value: Record<string, unknown>,
  location: string,
  keys: readonly string[],
): void {
  const supported = new Set(keys);
  const unknown = Object.keys(value).find((key) => !supported.has(key));
  if (unknown !== undefined) {
    throw new Error(`${location}.${unknown} is not supported`);
  }
}

/** Requires a non-empty proxy configuration string. */
function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

/** Requires an integer within an inclusive operational range. */
function requireInteger(
  value: unknown,
  location: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(
      `${location} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value as number;
}

/** Requires a valid TCP port number. */
function requirePort(value: unknown, location: string): number {
  return requireInteger(value, location, 1, 65_535);
}

/** Reads an optional bounded integer or returns its packaged default. */
function optionalInteger(
  value: unknown,
  location: string,
  fallback: number,
  maximum: number,
  minimum = 1,
): number {
  return value === undefined
    ? fallback
    : requireInteger(value, location, minimum, maximum);
}

/** Requires a supported private-network policy mode. */
function requirePrivateNetworkAccess(
  value: unknown,
  location: string,
): "allow" | "deny" {
  if (value !== "allow" && value !== "deny") {
    throw new Error(`${location} must be allow or deny`);
  }
  return value;
}

/** Requires one syntactically valid IPv4 or IPv6 CIDR rule. */
function requireCidr(value: unknown, location: string): string {
  const cidr = requireString(value, location);
  const separator = cidr.lastIndexOf("/");
  if (separator <= 0 || separator === cidr.length - 1) {
    throw new Error(`${location} must be an IPv4 or IPv6 CIDR`);
  }
  const address = cidr.slice(0, separator);
  const family = isIP(address);
  const prefix = Number(cidr.slice(separator + 1));
  const maximumPrefix = family === 4 ? 32 : family === 6 ? 128 : -1;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximumPrefix) {
    throw new Error(`${location} must be an IPv4 or IPv6 CIDR`);
  }
  return cidr;
}

/** Requires an array of unique syntactically valid CIDR rules. */
function requireCidrs(value: unknown, location: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array`);
  }
  const cidrs = value.map((entry, index) =>
    requireCidr(entry, `${location}[${index}]`),
  );
  if (new Set(cidrs).size !== cidrs.length) {
    throw new Error(`${location} must not contain duplicate CIDRs`);
  }
  return cidrs;
}

/** Loads one strict principal entry while preserving stable ownership identity. */
function loadPrincipal(
  value: unknown,
  index: number,
): ProxyPrincipalConfiguration {
  const location = `config.principals[${index}]`;
  const principal = requireRecord(value, location);
  requireKnownKeys(principal, location, ["id", "bearerToken"]);
  return {
    id: requireString(principal.id, `${location}.id`),
    bearerToken: requireString(
      principal.bearerToken,
      `${location}.bearerToken`,
    ),
  };
}

/** Loads enforceable runtime limits from validated administrator values. */
function loadLimits(value: unknown): ProxyLimitsConfiguration {
  const limits = requireRecord(value ?? {}, "config.limits");
  requireKnownKeys(limits, "config.limits", Object.keys(DEFAULT_PROXY_LIMITS));
  return {
    maxMetadataBytes: optionalInteger(
      limits.maxMetadataBytes,
      "config.limits.maxMetadataBytes",
      DEFAULT_PROXY_LIMITS.maxMetadataBytes,
      CONFIGURATION_CEILINGS.maxMetadataBytes,
    ),
    maxRequestHeaderCount: optionalInteger(
      limits.maxRequestHeaderCount,
      "config.limits.maxRequestHeaderCount",
      DEFAULT_PROXY_LIMITS.maxRequestHeaderCount,
      CONFIGURATION_CEILINGS.maxRequestHeaderCount,
    ),
    maxRequestBodyBytes: optionalInteger(
      limits.maxRequestBodyBytes,
      "config.limits.maxRequestBodyBytes",
      DEFAULT_PROXY_LIMITS.maxRequestBodyBytes,
      CONFIGURATION_CEILINGS.maxRequestBodyBytes,
      0,
    ),
    maxResponseBodyBytes: optionalInteger(
      limits.maxResponseBodyBytes,
      "config.limits.maxResponseBodyBytes",
      DEFAULT_PROXY_LIMITS.maxResponseBodyBytes,
      CONFIGURATION_CEILINGS.maxResponseBodyBytes,
    ),
    maxCacheBytesPerPrincipal: optionalInteger(
      limits.maxCacheBytesPerPrincipal,
      "config.limits.maxCacheBytesPerPrincipal",
      DEFAULT_PROXY_LIMITS.maxCacheBytesPerPrincipal,
      CONFIGURATION_CEILINGS.maxCacheBytesPerPrincipal,
      4_096,
    ),
    maxConcurrentExecutionsPerPrincipal: optionalInteger(
      limits.maxConcurrentExecutionsPerPrincipal,
      "config.limits.maxConcurrentExecutionsPerPrincipal",
      DEFAULT_PROXY_LIMITS.maxConcurrentExecutionsPerPrincipal,
      CONFIGURATION_CEILINGS.maxConcurrentExecutionsPerPrincipal,
    ),
  };
}

/** Loads administrator target-address policy with secure defaults. */
function loadTargetPolicy(value: unknown): ProxyTargetPolicyConfiguration {
  const policy = requireRecord(value ?? {}, "config.targetPolicy");
  requireKnownKeys(policy, "config.targetPolicy", [
    "privateNetworkAccess",
    "allowCidrs",
    "denyCidrs",
  ]);
  return {
    privateNetworkAccess:
      policy.privateNetworkAccess === undefined
        ? "deny"
        : requirePrivateNetworkAccess(
            policy.privateNetworkAccess,
            "config.targetPolicy.privateNetworkAccess",
          ),
    allowCidrs:
      policy.allowCidrs === undefined
        ? []
        : requireCidrs(policy.allowCidrs, "config.targetPolicy.allowCidrs"),
    denyCidrs:
      policy.denyCidrs === undefined
        ? []
        : requireCidrs(policy.denyCidrs, "config.targetPolicy.denyCidrs"),
  };
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
  requireKnownKeys(document, "config", [
    "configVersion",
    "server",
    "cache",
    "limits",
    "targetPolicy",
    "principals",
  ]);
  if (document.configVersion !== 1) {
    throw new Error("config.configVersion must be 1");
  }

  const server = requireRecord(document.server ?? {}, "config.server");
  requireKnownKeys(server, "config.server", ["host", "port"]);
  const cache = requireRecord(document.cache ?? {}, "config.cache");
  requireKnownKeys(cache, "config.cache", ["path", "retentionMs"]);
  const rawPrincipals = document.principals;
  if (!Array.isArray(rawPrincipals) || rawPrincipals.length === 0) {
    throw new Error("config.principals must contain at least one principal");
  }
  const principals = rawPrincipals.map(loadPrincipal);
  if (new Set(principals.map(({ id }) => id)).size !== principals.length) {
    throw new Error("config.principals must use unique principal ids");
  }
  if (
    new Set(principals.map(({ bearerToken }) => bearerToken)).size !==
    principals.length
  ) {
    throw new Error("config.principals must use unique bearer tokens");
  }

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
      retentionMs: optionalInteger(
        cache.retentionMs,
        "config.cache.retentionMs",
        DEFAULT_RESPONSE_CACHE_RETENTION_MS,
        CONFIGURATION_CEILINGS.retentionMs,
      ),
    },
    limits: loadLimits(document.limits),
    targetPolicy: loadTargetPolicy(document.targetPolicy),
    principals,
  };
}
