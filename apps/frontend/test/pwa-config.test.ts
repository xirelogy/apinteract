import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { pwaOptions } from "../vite.config";

const frontendRoot = fileURLToPath(new URL("..", import.meta.url));

describe("PWA installation and cache policy", () => {
  it("uses the stable frontend root and required install icon variants", async () => {
    expect(pwaOptions.manifest).toMatchObject({
      id: "/web-ui/",
      start_url: "/web-ui/",
      scope: "/web-ui/",
      display: "standalone",
      background_color: "#1e2729",
      theme_color: "#1e2729",
    });
    expect(pwaOptions.manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "192x192" }),
        expect.objectContaining({ sizes: "512x512" }),
        expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
      ]),
    );
    await expectPngDimensions("icons/icon-192.png", 192, 192);
    await expectPngDimensions("icons/icon-512.png", 512, 512);
    await expectPngDimensions("icons/icon-maskable-512.png", 512, 512);
    await expectPngDimensions("icons/apple-touch-icon.png", 180, 180);
  });

  it("precaches only static files and denies backend navigation fallbacks", () => {
    expect(pwaOptions.workbox.runtimeCaching).toHaveLength(2);
    expect(pwaOptions.workbox.runtimeCaching[0]?.handler).toBe("CacheFirst");
    expect(pwaOptions.workbox.runtimeCaching[1]?.handler).toBe("NetworkFirst");
    expect(pwaOptions.workbox.globPatterns).toEqual([
      "**/*.{js,css,html,ico,png,svg,json}",
    ]);
    const denylist = pwaOptions.workbox.navigateFallbackDenylist;
    expect(denylist.some((pattern) => pattern.test("/auth/session"))).toBe(
      true,
    );
    expect(denylist.some((pattern) => pattern.test("/api/workspaces"))).toBe(
      true,
    );
    expect(denylist.some((pattern) => pattern.test("/ws"))).toBe(true);
    expect(denylist.some((pattern) => pattern.test("/web-ui/"))).toBe(false);
  });
});

/** Verifies one generated asset is an opaque PNG with exact dimensions. */
async function expectPngDimensions(
  relativePath: string,
  width: number,
  height: number,
): Promise<void> {
  const path = `${frontendRoot}/public/${relativePath}`;
  expect((await stat(path)).size).toBeGreaterThan(0);
  const bytes = await readFile(path);
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  expect(bytes.readUInt32BE(16)).toBe(width);
  expect(bytes.readUInt32BE(20)).toBe(height);
  expect(bytes[25]).toBe(2);
}
