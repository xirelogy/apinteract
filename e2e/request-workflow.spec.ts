import { expect, test, type Page } from "@playwright/test";

test("creates, restores, and sends the first workspace request", async ({
  page,
}, testInfo) => {
  const suffix = testInfo.project.name;
  const workspaceName = `First workspace ${suffix}`;
  const collectionName = `Getting started ${suffix}`;
  const requestName = `Hello fixture ${suffix}`;
  const targetUrl = "http://127.0.0.1:8090/hello";

  await login(page);

  await page.getByLabel("New workspace name").fill(workspaceName);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.locator("#workspace-select option:checked")).toHaveText(
    workspaceName,
  );

  await page.getByLabel("New collection name").fill(collectionName);
  await page.getByRole("button", { name: "Create collection" }).click();
  const collection = page
    .getByRole("navigation", { name: "Collections" })
    .getByRole("button", { name: collectionName });
  await expect(collection).toBeVisible();
  await collection.click();

  await page.getByLabel("New request name").fill(requestName);
  await page.getByLabel("New request URL").fill(targetUrl);
  await page.getByRole("button", { name: "Add request" }).click();
  await expect(page.getByLabel("Request name", { exact: true })).toHaveValue(
    requestName,
  );
  await expect(page.getByLabel("Target URL")).toHaveValue(targetUrl);

  await page.reload();
  await page
    .getByLabel("Workspace", { exact: true })
    .selectOption({ label: workspaceName });
  await page
    .getByRole("navigation", { name: "Collections" })
    .getByRole("button", { name: collectionName })
    .click();
  await page
    .getByRole("navigation", { name: "Requests" })
    .getByRole("button", { name: `GET ${requestName}` })
    .click();

  await expect(page.getByLabel("Request name", { exact: true })).toHaveValue(
    requestName,
  );
  await expect(page.getByLabel("Target URL")).toHaveValue(targetUrl);
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.locator(".status-code")).toHaveText("200");
  await expect(page.locator(".body-preview")).toContainText(
    "Hello from the APInteract fixture.",
  );
});

/** Authenticates the isolated browser-test administrator. */
async function login(page: Page): Promise<void> {
  await page.goto("/web-ui/#/login");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("Browser-test-password-1!");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/#\/main$/u);
}
