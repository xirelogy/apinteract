import { expect, test } from "@playwright/test";

test("exposes install metadata and recovers an authenticated online session", async ({
  context,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await page.goto("/web-ui/#/login");

  const manifestPath = await page
    .locator('link[rel="manifest"]')
    .getAttribute("href");
  expect(manifestPath).toBe("/web-ui/manifest.webmanifest");
  const manifestResponse = await page.request.get(manifestPath ?? "");
  expect(manifestResponse.ok()).toBe(true);
  await expect(manifestResponse.json()).resolves.toMatchObject({
    id: "/web-ui/",
    scope: "/web-ui/",
    start_url: "/web-ui/",
    display: "standalone",
  });

  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("Browser-test-password-1!");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("button", { name: "Account menu for admin" }),
  ).toBeVisible({ timeout: 15_000 });

  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Account menu for admin" }),
  ).toBeVisible({ timeout: 15_000 });
  const cachedUrls = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      urls.push(...(await cache.keys()).map((request) => request.url));
    }
    return urls;
  });
  expect(cachedUrls.length).toBeGreaterThan(0);
  for (const value of cachedUrls) {
    const url = new URL(value);
    expect(url.origin).toBe("http://127.0.0.1:5173");
    expect(
      url.pathname.startsWith("/web-ui/") ||
        url.pathname === "/plugins/catalog.json" ||
        /^\/plugins\/[a-z0-9]+(?:[.-][a-z0-9]+)*\/[a-f0-9]{64}\/.+$/u.test(
          url.pathname,
        ),
    ).toBe(true);
    expect(url.pathname).not.toMatch(/^\/(?:auth|api|ws)(?:\/|$)/u);
  }

  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "APInteract is offline" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("button", { name: "Account menu for admin" }),
  ).toHaveCount(0);

  await context.setOffline(false);
  await expect(
    page.getByRole("button", { name: "Account menu for admin" }),
  ).toBeVisible({ timeout: 15_000 });
});
