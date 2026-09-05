import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  AUTH_PROVIDER_PLUGIN_MANIFEST_SCHEMA_VERSION,
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
} from "@apinteract/plugin-api";

import {
  discoverPluginPackages,
  loadBackendPluginModule,
} from "../src/plugins/plugin-discovery.js";

describe("plugin package discovery", () => {
  it("classifies equivalent roots and loads a validated backend entrypoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "apinteract-plugins-"));
    try {
      const builtinRoot = join(root, "builtin");
      const userRoot = join(root, "user");
      await writePlugin(builtinRoot, "frontend", "example.frontend");
      await writePlugin(userRoot, "backend", "example.backend");
      const invalid: string[] = [];
      const discovered = await discoverPluginPackages(
        [
          { path: builtinRoot, source: "built-in" },
          { path: userRoot, source: "user" },
        ],
        (path) => invalid.push(path),
      );

      expect(invalid).toEqual([]);
      expect(
        discovered.map((plugin) => ({
          id: plugin.manifest.id,
          source: plugin.source,
          hashLength: plugin.contentHash.length,
        })),
      ).toEqual([
        {
          id: "example.frontend",
          source: "built-in",
          hashLength: 64,
        },
        { id: "example.backend", source: "user", hashLength: 64 },
      ]);
      const backend = discovered.find(
        (plugin) => plugin.manifest.target === "backend",
      );
      expect(backend).toBeDefined();
      if (backend === undefined)
        throw new Error("Backend fixture was not found");
      const loaded = await loadBackendPluginModule(backend);
      expect(typeof loaded.register).toBe("function");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes escaping entrypoints and rejects duplicate IDs across roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "apinteract-plugins-"));
    try {
      const builtinRoot = join(root, "builtin");
      const userRoot = join(root, "user");
      const packagePath = await writePlugin(
        builtinRoot,
        "backend",
        "example.escape",
      );
      await writeFile(
        join(root, "outside.mjs"),
        "export function register() {}\n",
      );
      await rm(join(packagePath, "dist", "index.mjs"));
      await symlink(
        join(root, "outside.mjs"),
        join(packagePath, "dist", "index.mjs"),
      );
      const invalid: string[] = [];
      expect(
        await discoverPluginPackages(
          [{ path: builtinRoot, source: "built-in" }],
          (path) => invalid.push(path),
        ),
      ).toEqual([]);
      expect(invalid).toEqual([packagePath]);

      await writePlugin(builtinRoot, "backend", "example.duplicate", "a");
      await writePlugin(userRoot, "backend", "example.duplicate", "b");
      await expect(
        discoverPluginPackages(
          [
            { path: builtinRoot, source: "built-in" },
            { path: userRoot, source: "user" },
          ],
          () => undefined,
        ),
      ).rejects.toThrow(/Duplicate discovered plugin ID/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts complete built-in auth bundles and rejects them from user roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "apinteract-auth-plugins-"));
    try {
      const builtinRoot = join(root, "builtin");
      const userRoot = join(root, "user");
      await writeAuthPlugin(builtinRoot, "builtin.password");
      await writeAuthPlugin(userRoot, "user.password");
      const invalid: string[] = [];
      const discovered = await discoverPluginPackages(
        [
          { path: builtinRoot, source: "built-in" },
          { path: userRoot, source: "user" },
        ],
        (path) => invalid.push(path),
      );
      expect(discovered.map(({ manifest }) => manifest.id)).toEqual([
        "builtin.password",
      ]);
      expect(invalid).toEqual([join(userRoot, "user.password")]);
      expect(discovered[0]?.manifest).toMatchObject({
        schemaVersion: AUTH_PROVIDER_PLUGIN_MANIFEST_SCHEMA_VERSION,
        target: "auth-provider",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** Writes one minimal independently discoverable package fixture. */
async function writePlugin(
  root: string,
  target: "frontend" | "backend",
  id: string,
  directory = id,
): Promise<string> {
  const packagePath = join(root, directory);
  await mkdir(join(packagePath, "dist"), { recursive: true });
  await writeFile(
    join(packagePath, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0", type: "module" }),
  );
  await writeFile(
    join(packagePath, "apinteract-plugin.json"),
    JSON.stringify({
      schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
      apiVersion: PLUGIN_API_VERSION,
      id,
      name: id,
      version: "1.0.0",
      target,
      entrypoint: "dist/index.mjs",
      providers: [
        target === "frontend" ? "response.content" : "request.import",
      ],
    }),
  );
  await writeFile(
    join(packagePath, "dist", "index.mjs"),
    "export function register() {}\n",
  );
  return packagePath;
}

/** Writes one complete dual-entrypoint authentication bundle fixture. */
async function writeAuthPlugin(root: string, id: string): Promise<string> {
  const packagePath = join(root, id);
  await mkdir(join(packagePath, "dist"), { recursive: true });
  await writeFile(
    join(packagePath, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0", type: "module" }),
  );
  await writeFile(
    join(packagePath, "apinteract-plugin.json"),
    JSON.stringify({
      schemaVersion: AUTH_PROVIDER_PLUGIN_MANIFEST_SCHEMA_VERSION,
      apiVersion: PLUGIN_API_VERSION,
      id,
      name: id,
      version: "1.0.0",
      target: "auth-provider",
      entrypoints: {
        backend: "dist/backend.mjs",
        frontend: "dist/frontend.mjs",
      },
      providers: {
        backend: ["authentication.provider"],
        frontend: ["authentication.login"],
      },
    }),
  );
  await writeFile(
    join(packagePath, "dist", "backend.mjs"),
    "export function register() {}\n",
  );
  await writeFile(
    join(packagePath, "dist", "frontend.mjs"),
    "export function register() {}\n",
  );
  return packagePath;
}
