import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

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
    await writeFile(join(frontendPath, "manifest.webmanifest"), "{}");
    await writeFile(
      join(frontendPath, "sw.js"),
      "self.addEventListener('fetch', () => {});",
    );
    const application = {
      proxy: { health: () => Promise.resolve(true) },
      audit: {
        pendingCount: () => Promise.resolve(0),
        publishPending: () => Promise.resolve(0),
      },
      plugins: {
        frontendCatalog: () => [],
        frontendAsset: (id: string, hash: string, assetPath: string) =>
          id === "example.frontend" &&
          hash === "a".repeat(64) &&
          assetPath === "chunks/presenter.js"
            ? {
                bytes: Buffer.from("export {};"),
                contentType: "text/javascript; charset=utf-8",
              }
            : undefined,
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

      const manifest = await server.inject({
        method: "GET",
        url: "/web-ui/manifest.webmanifest",
      });
      expect(manifest.statusCode).toBe(200);
      expect(manifest.headers["content-type"]).toContain(
        "application/manifest+json",
      );
      expect(manifest.headers["cache-control"]).toBe("no-cache");

      const serviceWorker = await server.inject({
        method: "GET",
        url: "/web-ui/sw.js",
      });
      expect(serviceWorker.statusCode).toBe(200);
      expect(serviceWorker.headers["content-type"]).toContain("javascript");
      expect(serviceWorker.headers["cache-control"]).toBe("no-cache");

      const pluginAsset = await server.inject({
        method: "GET",
        url: `/plugins/example.frontend/${"a".repeat(64)}/chunks/presenter.js`,
      });
      expect(pluginAsset.statusCode).toBe(200);
      expect(pluginAsset.body).toBe("export {};");
      expect(pluginAsset.headers["content-type"]).toContain("javascript");
      expect(pluginAsset.headers["cache-control"]).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(pluginAsset.headers["x-content-type-options"]).toBe("nosniff");

      const stalePluginAsset = await server.inject({
        method: "GET",
        url: `/plugins/example.frontend/${"b".repeat(64)}/chunks/presenter.js`,
      });
      expect(stalePluginAsset.statusCode).toBe(404);

      const redirect = await server.inject({
        method: "GET",
        url: "/web-ui",
      });
      expect(redirect.statusCode).toBe(302);
      expect(redirect.headers.location).toBe("/web-ui/");

      const deploymentRoot = await server.inject({ method: "GET", url: "/" });
      expect(deploymentRoot.statusCode).toBe(302);
      expect(deploymentRoot.headers.location).toBe("/web-ui/");
    } finally {
      await server.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("authenticates and stores exact multipart request attachment bytes", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-upload-"));
    const userId = "019facab-1eee-765f-bd9f-ac2449151ea1";
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151ea2";
    const attachment = {
      attachmentId: "019facab-1eee-765f-bd9f-ac2449151ea3",
      workspaceId,
      fileName: "示例.bin",
      contentType: "application/octet-stream",
      byteLength: 4,
      sha256: "a".repeat(64),
    };
    const upload = vi.fn().mockResolvedValue(attachment);
    const application = {
      proxy: { health: () => Promise.resolve(true) },
      audit: {
        pendingCount: () => Promise.resolve(0),
        publishPending: () => Promise.resolve(0),
      },
      sessions: {
        authenticateAccessToken: () =>
          Promise.resolve({
            sessionId: "019facab-1eee-765f-bd9f-ac2449151ea4",
            user: { id: userId },
          }),
      },
      requestAttachments: { upload },
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
      frontend: { distPath: join(rootPath, "missing") },
    };
    const server = await createBackendServer(application, configuration);
    const bytes = Buffer.from([0, 1, 2, 255]);

    try {
      const response = await server.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/request-attachments`,
        headers: {
          authorization: "Bearer access-token",
          "content-type": "application/octet-stream",
          "x-apinteract-file-name": encodeURIComponent(attachment.fileName),
          "x-apinteract-file-type": encodeURIComponent(attachment.contentType),
        },
        payload: bytes,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual(attachment);
      expect(upload).toHaveBeenCalledWith(
        userId,
        workspaceId,
        attachment.fileName,
        attachment.contentType,
        bytes,
      );
      const oversized = await server.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/request-attachments`,
        headers: {
          authorization: "Bearer access-token",
          "content-type": "application/octet-stream",
          "x-apinteract-file-name": "large.bin",
        },
        payload: Buffer.alloc(786_433),
      });
      expect(oversized.statusCode).toBe(413);
      expect(oversized.json()).toMatchObject({
        code: "request_attachment_too_large",
      });
      expect(upload).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
