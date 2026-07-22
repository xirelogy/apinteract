import { expect, test, type Page } from "@playwright/test";

test("creates, restores, and sends the first workspace request", async ({
  page,
}, testInfo) => {
  const suffix = testInfo.project.name;
  const workspaceName = `First workspace ${suffix}`;
  const collectionName = `Getting started ${suffix}`;
  const subcollectionName = `Examples ${suffix}`;
  const requestName = `Hello fixture ${suffix}`;
  const targetUrl = "http://127.0.0.1:8090/echo";
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
  if (mobile) {
    await expect(
      page.getByRole("button", { name: "Open workspace navigator" }),
    ).toBeVisible();
  }
  const draftRevision = page.locator(".draft-revision");
  await expect(draftRevision).toHaveText("Temporary");
  await page.getByLabel("Request name", { exact: true }).fill(requestName);
  await page.getByLabel("Target URL").fill(targetUrl);
  await page.getByLabel("HTTP method").selectOption("POST");
  await page.getByRole("button", { name: "Add parameter" }).click();
  await page.getByLabel("Query name 1").fill("source");
  await page.getByLabel("Query value 1").fill(suffix);
  await page.getByRole("tab", { name: "Headers 0" }).click();
  await page.getByRole("button", { name: "Add header" }).click();
  await page.getByLabel("Header name 1").fill("X-Fixture-Request");
  await page.getByLabel("Header value 1").fill("browser-test");
  await page.getByRole("tab", { name: "Body" }).click();
  await page.getByLabel("Raw request body").fill(`payload-${suffix}`);
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByRole("status")).toHaveText("In progress");
  await expect(page.locator(".status-code")).toHaveText("201");
  await expect(page.locator(".body-preview")).toContainText(`"method":"POST"`);
  await expect(page.locator(".body-preview")).toContainText(
    `"query":[["source","${suffix}"]]`,
  );
  await expect(page.locator(".body-preview")).toContainText(
    `"requestHeader":"browser-test"`,
  );
  await expect(page.locator(".body-preview")).toContainText(
    `"body":"payload-${suffix}"`,
  );
  await expect(draftRevision).toHaveText("Temporary");
  await expect(
    workspaceTree.getByRole("button", {
      name: `POST ${requestName}`,
      exact: true,
    }),
  ).toHaveCount(0);

  await page
    .getByRole("tablist", { name: "Response details" })
    .getByRole("tab", { name: /Headers/u })
    .click();
  await expect(page.locator(".response-headers")).toContainText(
    "x-fixture-response",
  );
  await expect(page.locator(".response-headers")).toContainText("echoed");

  await page.getByRole("button", { name: "New temporary request" }).click();
  await expect(page.locator(".request-tab")).toHaveCount(2);
  if (mobile) {
    const requestMenuTrigger = page.getByRole("button", {
      name: /Current request:/u,
    });
    await requestMenuTrigger.click();
    const requestMenu = page.getByRole("menu", { name: "Open requests" });
    await expect(requestMenu.getByRole("menuitemradio")).toHaveCount(2);
    const triggerBox = await requestMenuTrigger.boundingBox();
    const menuBox = await requestMenu.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(menuBox).not.toBeNull();
    expect(
      Math.abs((menuBox?.x ?? 0) - (triggerBox?.x ?? 0)),
    ).toBeLessThanOrEqual(1);
    expect(menuBox?.y ?? 0).toBeGreaterThanOrEqual(
      (triggerBox?.y ?? 0) + (triggerBox?.height ?? 0),
    );
    await requestMenuTrigger.click();
  }
  await page
    .getByLabel("Request name", { exact: true })
    .fill(`Scratch ${suffix}`);
  if (mobile) {
    await expect(
      page.getByRole("button", {
        name: new RegExp(`Current request: GET Scratch ${suffix}`, "u"),
      }),
    ).toBeVisible();
  }
  await page.getByLabel("Target URL").fill("http://127.0.0.1:8090/hello");
  await page.getByRole("button", { name: `Close Scratch ${suffix}` }).click();
  const discardDialog = page.getByRole("dialog", {
    name: "Discard changes?",
  });
  await discardDialog.getByRole("button", { name: "Discard" }).click();
  await expect(page.locator(".request-tab")).toHaveCount(1);
  await expect(page.getByLabel("Request name", { exact: true })).toHaveValue(
    requestName,
  );
  await page
    .getByRole("tablist", { name: "Response details" })
    .getByRole("tab", { name: "Raw" })
    .click();
  await expect(page.locator(".body-preview")).toContainText(`"method":"POST"`);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  const saveDialog = page.getByRole("dialog", { name: "Save request" });
  await expect(saveDialog.getByLabel("Saved request name")).toHaveValue(
    requestName,
  );
  const destinationTree = saveDialog.getByRole("tree", {
    name: "Destination collection",
  });
  const destinationCollection = destinationTree.getByRole("button", {
    name: subcollectionName,
    exact: true,
  });
  await expect(destinationCollection.locator("..")).toHaveClass(/is-selected/u);
  await saveDialog.getByRole("button", { name: "Save" }).click();
  const requestNode = workspaceTree.getByRole("button", {
    name: `POST ${requestName}`,
    exact: true,
  });
  await expect(requestNode).toHaveClass(/is-selected/u);
  await expect(subcollection.locator("..")).not.toHaveClass(/is-selected/u);
  await expect(draftRevision).toHaveText("Draft 0");

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
    .getByRole("button", { name: `POST ${requestName}`, exact: true })
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
  await expect(page.getByLabel("HTTP method")).toHaveValue("POST");
  await page.getByRole("tab", { name: "Body" }).click();
  await expect(page.getByLabel("Raw request body")).toHaveValue(
    `payload-${suffix}`,
  );
  await expect(draftRevision).toHaveText("Draft 0");

  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("status")).toHaveText("In progress");
  await expect(page.locator(".status-code")).toHaveText("201");
  await expect(draftRevision).toHaveText("Draft 0");
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
