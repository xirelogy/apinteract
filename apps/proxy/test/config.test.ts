import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  it("loads the shipped AIO administrator sample with its generated principal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "apinteract-proxy-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "proxy.yaml");
    const sample = await readFile(
      resolve(
        import.meta.dirname,
        "../../../deploy/aio/configuration/proxy.yaml",
      ),
      "utf8",
    );
    await writeFile(
      path,
      `${sample}\nprincipals:\n  - id: aio-backend\n    bearerToken: generated-test-token\n`,
    );

    const configuration = await loadProxyConfiguration(path);

    expect(configuration.cache.retentionMs).toBe(900_000);
    expect(configuration.limits).toEqual(DEFAULT_PROXY_LIMITS);
    expect(configuration.targetPolicy.privateNetworkAccess).toBe("deny");
    expect(configuration.transportObservations.enabled).toBe(true);
  });

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
    expect(configuration.transportObservations).toEqual({ enabled: true });
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
      transportObservations: { enabled: false },
      principals: [{ id: "backend", bearerToken: "secret" }],
    });

    expect(configuration.cache).toEqual({
      path: "/transfer-cache",
      retentionMs: 30_000,
    });
    expect(configuration.limits.maxConcurrentExecutionsPerPrincipal).toBe(3);
    expect(configuration.targetPolicy.denyCidrs).toEqual(["10.20.5.0/24"]);
    expect(configuration.transportObservations).toEqual({ enabled: false });
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
    await expect(
      load({
        configVersion: 1,
        transportObservations: { enabled: "yes" },
        principals: [{ id: "backend", bearerToken: "secret" }],
      }),
    ).rejects.toThrow("config.transportObservations.enabled must be a boolean");
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
