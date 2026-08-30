import { expect, test, type Page } from "@playwright/test";

test("lists discovered frontend and backend plugins read-only", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  await login(page);

  await page.getByRole("button", { name: "Account menu for admin" }).click();
  await page.getByRole("menuitem", { name: "Options" }).click();
  const options = page.getByRole("dialog", { name: "Options" });
  await options.getByRole("tab", { name: "Plugins" }).click();
  const plugins = options.getByRole("list", { name: "Enabled plugins" });

  await expect(plugins.getByRole("listitem")).toHaveCount(7);
  await expect(plugins).toContainText("Basic HTTP content");
  await expect(plugins).toContainText("JSON content");
  await expect(plugins).toContainText("HAR import");
  await expect(plugins).toContainText("OpenAPI import");
  await expect(plugins).toContainText("Frontend");
  await expect(plugins).toContainText("Backend");
  await expect(plugins).toContainText("Built-in");
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
