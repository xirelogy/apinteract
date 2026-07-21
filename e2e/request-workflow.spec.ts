import { expect, test, type Page } from "@playwright/test";

test("creates, restores, and sends the first workspace request", async ({
  page,
}, testInfo) => {
  const suffix = testInfo.project.name;
  const workspaceName = `First workspace ${suffix}`;
  const collectionName = `Getting started ${suffix}`;
  const subcollectionName = `Examples ${suffix}`;
  const requestName = `Hello fixture ${suffix}`;
  const targetUrl = "http://127.0.0.1:8090/hello";
  const mobile = testInfo.project.name === "mobile-chromium";

  await login(page);
  await expectWorkbenchFillsViewport(page);
  await openNavigator(page, mobile);

  await page.getByRole("button", { name: "Create workspace" }).click();
  const workspaceDialog = page.getByRole("dialog", { name: "New workspace" });
  await workspaceDialog.getByLabel("Workspace name").fill(workspaceName);
  await workspaceDialog.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("#workspace-select option:checked")).toHaveText(
    workspaceName,
  );

  await page.getByRole("button", { name: "Create root collection" }).click();
  const collectionDialog = page.getByRole("dialog", {
    name: "New collection",
  });
  await collectionDialog.getByLabel("Collection name").fill(collectionName);
  await collectionDialog.getByRole("button", { name: "Create" }).click();
  const workspaceTree = page.getByRole("navigation", {
    name: "Workspace tree",
  });
  const collection = page
    .getByRole("navigation", { name: "Workspace tree" })
    .getByRole("button", { name: collectionName, exact: true });
  await expect(collection).toBeVisible();
  await collection.click();

  await page
    .getByRole("button", {
      name: `Create subcollection in ${collectionName}`,
    })
    .click();
  const subcollectionDialog = page.getByRole("dialog", {
    name: "New subcollection",
  });
  await subcollectionDialog
    .getByLabel("Collection name")
    .fill(subcollectionName);
  await subcollectionDialog.getByRole("button", { name: "Create" }).click();
  const subcollection = workspaceTree.getByRole("button", {
    name: subcollectionName,
    exact: true,
  });
  await expect(subcollection).toBeVisible();
  await subcollection.click();

  await page.getByRole("button", { name: "Create request" }).click();
  const requestDialog = page.getByRole("dialog", { name: "New request" });
  await requestDialog.getByLabel("Request name").fill(requestName);
  await requestDialog.getByLabel("New request URL").fill(targetUrl);
  await requestDialog.getByRole("button", { name: "Create" }).click();
  if (mobile) {
    await expect(
      page.getByRole("button", { name: "Open workspace navigator" }),
    ).toBeVisible();
  }
  const requestNode = workspaceTree.getByRole("button", {
    name: `GET ${requestName}`,
    exact: true,
  });
  await expect(requestNode).toHaveClass(/is-selected/u);
  await expect(subcollection.locator("..")).not.toHaveClass(/is-selected/u);
  await expect(page.getByLabel("Request name", { exact: true })).toHaveValue(
    requestName,
  );
  await expect(page.getByLabel("Target URL")).toHaveValue(targetUrl);

  await page.reload();
  await openNavigator(page, mobile);
  await page
    .getByLabel("Workspace", { exact: true })
    .selectOption({ label: workspaceName });
  await workspaceTree
    .getByRole("button", { name: collectionName, exact: true })
    .click();
  await workspaceTree
    .getByRole("button", { name: subcollectionName, exact: true })
    .click();
  await workspaceTree
    .getByRole("button", { name: `GET ${requestName}`, exact: true })
    .click();
  if (mobile) {
    await expect(
      page.getByRole("button", { name: "Open workspace navigator" }),
    ).toBeVisible();
  }

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

/** Opens the overlay navigator only for the mobile browser project. */
async function openNavigator(page: Page, mobile: boolean): Promise<void> {
  if (mobile) {
    await page
      .getByRole("button", { name: "Open workspace navigator" })
      .click();
  }
}

/** Verifies the application work area consumes all space below the header. */
async function expectWorkbenchFillsViewport(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  const body = await page.locator(".application-body").boundingBox();
  expect(viewport).not.toBeNull();
  expect(body).not.toBeNull();
  expect(
    Math.abs((body?.y ?? 0) + (body?.height ?? 0) - (viewport?.height ?? 0)),
  ).toBeLessThanOrEqual(1);
}
