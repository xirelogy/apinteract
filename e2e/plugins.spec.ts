import { expect, test, type Page } from "@playwright/test";

test("lists discovered frontend and backend plugins read-only", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await login(page);

  await page.getByRole("button", { name: "Account menu for admin" }).click();
  await page.getByRole("menuitem", { name: "Options" }).click();
  const options = page.getByRole("dialog", { name: "Options" });
  const generalBox = await options.boundingBox();
  expect(generalBox).not.toBeNull();
  const optionsTabs = options.locator(".account-options-tabs");
  const languageControl = options.getByRole("combobox", { name: "Language" });
  await languageControl.focus();
  const [optionsTabsBox, languageControlBox] = await Promise.all([
    optionsTabs.boundingBox(),
    languageControl.boundingBox(),
  ]);
  expect(optionsTabsBox).not.toBeNull();
  expect(languageControlBox).not.toBeNull();
  expect(languageControlBox!.x - optionsTabsBox!.x).toBeGreaterThan(1);
  expect(
    optionsTabsBox!.x +
      optionsTabsBox!.width -
      (languageControlBox!.x + languageControlBox!.width),
  ).toBeGreaterThan(1);
  await options.getByRole("tab", { name: "Defaults" }).click();
  const defaultsBox = await options.boundingBox();
  expect(defaultsBox).not.toBeNull();
  expect(Math.abs(defaultsBox!.width - generalBox!.width)).toBeLessThan(2);
  expect(Math.abs(defaultsBox!.height - generalBox!.height)).toBeLessThan(2);
  await options.getByRole("tab", { name: "Plugins" }).click();
  const pluginsBox = await options.boundingBox();
  expect(pluginsBox).not.toBeNull();
  expect(Math.abs(pluginsBox!.width - generalBox!.width)).toBeLessThan(2);
  expect(Math.abs(pluginsBox!.height - generalBox!.height)).toBeLessThan(2);
  const plugins = options.getByRole("list", { name: "Enabled plugins" });

  await expect(plugins.getByRole("listitem")).toHaveCount(7);
  await expect(plugins).toContainText("Basic HTTP content");
  await expect(plugins).toContainText("JSON content");
  await expect(plugins).toContainText("HAR import");
  await expect(plugins).toContainText("OpenAPI import");
  await expect(plugins).toContainText("Frontend");
  await expect(plugins).toContainText("Backend");
  await expect(plugins).toContainText("Built-in");
  const pluginListOverflow = await plugins.evaluate((list) => ({
    overflowY: window.getComputedStyle(list).overflowY,
    scrollHeight: list.scrollHeight,
    clientHeight: list.clientHeight,
  }));
  expect(pluginListOverflow.overflowY).toBe("auto");
  expect(pluginListOverflow.scrollHeight).toBeGreaterThan(
    pluginListOverflow.clientHeight,
  );
  await expect(options.getByRole("button", { name: "Save" })).toBeEnabled();
});

/** Authenticates the browser-test administrator and waits for the main shell. */
async function login(page: Page): Promise<void> {
  await page.goto("/web-ui/#/login");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("Browser-test-password-1!");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("button", { name: "Account menu for admin" }),
  ).toBeVisible({ timeout: 15_000 });
}
