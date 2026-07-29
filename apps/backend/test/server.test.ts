import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Application } from "../src/bootstrap/application.js";
import type { BackendConfiguration } from "../src/config.js";
import { createBackendServer } from "../src/transport/server.js";

describe("backend static frontend hosting", () => {
  it("serves the SPA root and immutable compiled assets under web-ui", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-static-"));
    const frontendPath = join(rootPath, "frontend");
    await mkdir(frontendPath);
    await mkdir(join(frontendPath, "assets"));
    await writeFile(
      join(frontendPath, "index.html"),
      "<main>APInteract</main>",
    );
    await writeFile(join(frontendPath, "assets", "app-hash.js"), "export {};");
    const application = {
      proxy: { health: () => Promise.resolve(true) },
      audit: {
        pendingCount: () => Promise.resolve(0),
        publishPending: () => Promise.resolve(0),
      },
      close: () => Promise.resolve(),
    } as unknown as Application;
    const configuration: BackendConfiguration = {
      configVersion: 1,
      server: {
        host: "127.0.0.1",
        port: 8080,
        publicOrigin: "http://localhost:8080",
      },
      persistence: {
        databasePath: join(rootPath, "database.sqlite3"),
        migrationBackupDirectory: join(rootPath, "backups"),
      },
      blobs: {
        rootPath: join(rootPath, "blobs"),
        stagingPath: join(rootPath, "blob-staging"),
      },
      audit: { rootPath: join(rootPath, "audit") },
      proxy: {
        endpoint: "http://127.0.0.1:8081",
        bearerToken: "test-token",
      },
      sessions: {
        secureCookie: false,
        accessLifetimeSeconds: 900,
        refreshIdleLifetimeSeconds: 604_800,
        refreshAbsoluteLifetimeSeconds: 2_592_000,
      },
      frontend: { distPath: frontendPath },
    };
    const server = await createBackendServer(application, configuration);

    try {
      const root = await server.inject({ method: "GET", url: "/web-ui/" });
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain("APInteract");
      expect(root.headers["cache-control"]).toBe("no-cache");

      const asset = await server.inject({
        method: "GET",
        url: "/web-ui/assets/app-hash.js",
      });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["cache-control"]).toBe(
        "public, max-age=31536000, immutable",
      );

      const redirect = await server.inject({
        method: "GET",
        url: "/web-ui",
      });
      expect(redirect.statusCode).toBe(302);
      expect(redirect.headers.location).toBe("/web-ui/");
    } finally {
      await server.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
