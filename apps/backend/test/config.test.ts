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
