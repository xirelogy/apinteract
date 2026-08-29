import { expect, test, type Page } from "@playwright/test";

test("displays structured, isolated, image, and binary responses", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  test.setTimeout(90_000);

  await login(page);
  await createWorkspace(page, "Response display workspace");
  await page.getByRole("button", { name: "New temporary request" }).click();
  await page
    .getByLabel("Request name", { exact: true })
    .fill("Response display fixture");

  await sendFixtureRequest(page, "/response/json");
  const rawJson = page.getByLabel("Raw response body");
  const structuredJson = page.getByLabel("Formatted JSON response body");
  await expect(rawJson).toBeVisible();
  await expect(structuredJson).toBeHidden();
  await page
    .getByRole("tablist", { name: "Response details" })
    .getByRole("tab", { name: "JSON", exact: true })
    .click();
  await expect(rawJson).toBeHidden();
  await expect(structuredJson).toBeVisible();

  await sendFixtureRequest(page, "/response/xml");
  await page
    .getByRole("tablist", { name: "Response details" })
    .getByRole("tab", { name: "XML", exact: true })
    .click();
  const xml = page.getByLabel("Structured XML response body");
  await expect(xml).toContainText('<item id="1">value</item>');
  await expect(
    xml.locator("..").getByTitle("Fold line", { exact: true }),
  ).toBeVisible();

  const previewRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/preview-probe")) {
      previewRequests.push(request.url());
    }
  });
  await sendFixtureRequest(page, "/response/html");
  await page
    .getByRole("tablist", { name: "Response details" })
    .getByRole("tab", { name: "Preview", exact: true })
    .click();
  const html = page.getByTitle("Isolated HTML response preview");
  await expect(html).toHaveAttribute("sandbox", "");
  await expect(html).toHaveAttribute("srcdoc", /default-src 'none'/u);
  await expect(html).not.toHaveAttribute("srcdoc", /preview-probe/u);
  await expect(
    page
      .frameLocator('iframe[title="Isolated HTML response preview"]')
      .getByRole("heading", { name: "Fixture preview" }),
  ).toBeVisible();
  expect(previewRequests).toHaveLength(0);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { fixtureScriptRan?: boolean })
          .fixtureScriptRan,
    ),
  ).toBeUndefined();

  await sendFixtureRequest(page, "/response/image");
  await page
    .getByRole("tablist", { name: "Response details" })
    .getByRole("tab", { name: "Image", exact: true })
    .click();
  const image = page.getByRole("img", { name: "Response image preview" });
  await expect(image).toBeVisible();
  await expect(page.locator(".image-response-metadata")).toContainText(
    "1 × 1 pixels",
  );

  await sendFixtureRequest(page, "/response/invalid-image");
  await page
    .getByRole("tablist", { name: "Response details" })
    .getByRole("tab", { name: "Image", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "not a valid supported image",
  );

  await sendFixtureRequest(page, "/response/large-image");
  await expect(
    page
      .getByRole("tablist", { name: "Response details" })
      .getByRole("tab", { name: "Image", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".response-body-state")).toContainText(
    "exceeds the safe preview limits",
  );

  await sendFixtureRequest(page, "/response/binary");
  const binary = page.locator(".response-body-state");
  await expect(binary).toContainText("application/octet-stream");
  await expect(binary).toContainText("4 bytes");
  await expect(binary).toContainText("SHA-256");
  await expect(
    page.getByRole("button", { name: "Download response body" }),
  ).toBeVisible();
});

/** Authenticates the isolated browser-test administrator. */
async function login(page: Page): Promise<void> {
  await page.goto("/web-ui/#/login");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("Browser-test-password-1!");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/#\/main$/u);
}

/** Creates and selects the workspace required for temporary requests. */
async function createWorkspace(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Create workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "New workspace" });
  await dialog.getByLabel("Workspace name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(
    page.getByRole("combobox", { name: "Workspace", exact: true }),
  ).toContainText(name);
}

/** Executes one fixture endpoint and waits for its terminal response. */
async function sendFixtureRequest(page: Page, path: string): Promise<void> {
  await page.getByLabel("Target URL").fill(`http://127.0.0.1:8090${path}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("status")).toHaveText("In progress");
  await expect(page.locator(".status-code")).toHaveText("200");
}
