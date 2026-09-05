import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadBackendConfiguration } from "../src/config.js";

/** Writes one minimal backend configuration and returns its parsed result. */
async function loadConfiguration(rootPath: string, scripts?: unknown) {
  const path = join(rootPath, "backend.yaml");
  await writeFile(
    path,
    JSON.stringify({
      configVersion: 1,
      proxy: { endpoint: "http://proxy.test", bearerToken: "token" },
      ...(scripts === undefined ? {} : { scripts }),
    }),
  );
  return loadBackendConfiguration(path);
}

/** Writes arbitrary authentication configuration for boundary tests. */
async function loadAuthenticationConfiguration(
  rootPath: string,
  authentication: unknown,
) {
  const path = join(rootPath, "backend-auth.yaml");
  await writeFile(
    path,
    JSON.stringify({
      configVersion: 1,
      proxy: { endpoint: "http://proxy.test", bearerToken: "token" },
      authentication,
    }),
  );
  return loadBackendConfiguration(path);
}

describe("backend scripting configuration", () => {
  it("allows every persistent variable destination and secrets by default", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-config-"));
    try {
      const configuration = await loadConfiguration(rootPath);

      expect(configuration.scripts?.variableWrites).toEqual({
        allowedScopes: [
          "request",
          "parent-collection",
          "workspace",
          "selected-environment",
        ],
        allowSecrets: true,
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("accepts a narrowed persistent variable-write policy", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-config-"));
    try {
      const configuration = await loadConfiguration(rootPath, {
        variableWrites: {
          allowedScopes: ["workspace"],
          allowSecrets: false,
        },
      });

      expect(configuration.scripts?.variableWrites).toEqual({
        allowedScopes: ["workspace"],
        allowSecrets: false,
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});

describe("authentication provider configuration", () => {
  it("synthesizes one local-password instance only when omitted", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-auth-config-"));
    try {
      const configuration = await loadConfiguration(rootPath);
      expect(configuration.authentication?.providers).toEqual([
        {
          id: "local-password",
          plugin: "builtin.local-password",
          label: "Username and password",
          description: "Sign in with your APInteract username and password.",
          configuration: {},
        },
      ]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("preserves explicit order and rejects empty or duplicate instances", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-auth-config-"));
    try {
      const configuration = await loadAuthenticationConfiguration(rootPath, {
        providers: [
          {
            id: "company",
            plugin: "builtin.example",
            label: "Company",
            configuration: { tenant: "one" },
          },
          {
            id: "local",
            plugin: "builtin.local-password",
            label: "Password",
            configuration: {},
          },
        ],
      });
      expect(
        configuration.authentication?.providers.map(({ id }) => id),
      ).toEqual(["company", "local"]);
      await expect(
        loadAuthenticationConfiguration(rootPath, { providers: [] }),
      ).rejects.toThrow(/non-empty array/u);
      await expect(
        loadAuthenticationConfiguration(rootPath, {
          providers: [
            { id: "same", plugin: "builtin.one", label: "One" },
            { id: "same", plugin: "builtin.two", label: "Two" },
          ],
        }),
      ).rejects.toThrow(/duplicate id/u);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
