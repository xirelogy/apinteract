import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PROXY_LIMITS,
  DEFAULT_RESPONSE_CACHE_RETENTION_MS,
  loadProxyConfiguration,
} from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("proxy configuration", () => {
  it("applies secure policy and finite resource defaults", async () => {
    const configuration = await load({
      configVersion: 1,
      principals: [{ id: "backend", bearerToken: "secret" }],
    });

    expect(configuration.targetPolicy).toEqual({
      privateNetworkAccess: "deny",
      allowCidrs: [],
      denyCidrs: [],
    });
    expect(configuration.limits).toEqual(DEFAULT_PROXY_LIMITS);
    expect(configuration.cache.retentionMs).toBe(
      DEFAULT_RESPONSE_CACHE_RETENTION_MS,
    );
  });

  it("accepts documented target policy, quotas, and retention", async () => {
    const configuration = await load({
      configVersion: 1,
      cache: { path: "/transfer-cache", retentionMs: 30_000 },
      limits: {
        maxMetadataBytes: 32_000,
        maxRequestHeaderCount: 50,
        maxRequestBodyBytes: 100_000,
        maxResponseBodyBytes: 200_000,
        maxCacheBytesPerPrincipal: 400_000,
        maxConcurrentExecutionsPerPrincipal: 3,
      },
      targetPolicy: {
        privateNetworkAccess: "allow",
        allowCidrs: ["10.20.0.0/16", "fd12:3456::/48"],
        denyCidrs: ["10.20.5.0/24"],
      },
      principals: [{ id: "backend", bearerToken: "secret" }],
    });

    expect(configuration.cache).toEqual({
      path: "/transfer-cache",
      retentionMs: 30_000,
    });
    expect(configuration.limits.maxConcurrentExecutionsPerPrincipal).toBe(3);
    expect(configuration.targetPolicy.denyCidrs).toEqual(["10.20.5.0/24"]);
  });

  it("rejects unknown settings, malformed CIDRs, and duplicate identities", async () => {
    await expect(
      load({
        configVersion: 1,
        targetPolicy: { privateNetworkAccess: "deny", unexpected: true },
        principals: [{ id: "backend", bearerToken: "secret" }],
      }),
    ).rejects.toThrow("config.targetPolicy.unexpected is not supported");
    await expect(
      load({
        configVersion: 1,
        targetPolicy: { allowCidrs: ["10.0.0.0/99"] },
        principals: [{ id: "backend", bearerToken: "secret" }],
      }),
    ).rejects.toThrow("must be an IPv4 or IPv6 CIDR");
    await expect(
      load({
        configVersion: 1,
        principals: [
          { id: "backend", bearerToken: "one" },
          { id: "backend", bearerToken: "two" },
        ],
      }),
    ).rejects.toThrow("unique principal ids");
  });
});

/** Writes and loads one isolated JSON-compatible YAML configuration. */
async function load(value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "apinteract-proxy-config-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "proxy.yaml");
  await writeFile(path, JSON.stringify(value));
  return loadProxyConfiguration(path);
}
