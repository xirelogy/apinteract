import { readFile } from "node:fs/promises";

import { expect, test, type Locator, type Page } from "@playwright/test";

test("creates, restores, and sends the first workspace request", async ({
  page,
}, testInfo) => {
  const suffix = testInfo.project.name;
  const workspaceName = `First workspace ${suffix}`;
  const collectionName = `Getting started ${suffix}`;
  const subcollectionName = `Examples ${suffix}`;
  const leafCollectionName = `Inherited ${suffix}`;
  const requestName = `Hello fixture ${suffix}`;
  const environmentName = `Development ${suffix}`;
  const mobile = testInfo.project.name === "mobile-chromium";

  await login(page);
  await expectWorkbenchFillsViewport(page);
  await openNavigator(page, mobile);

  await page.getByRole("button", { name: "Create workspace" }).click();
  const workspaceDialog = page.getByRole("dialog", { name: "New workspace" });
  await workspaceDialog.getByLabel("Workspace name").fill(workspaceName);
  await workspaceDialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByLabel("Workspace", { exact: true })).toContainText(
    workspaceName,
  );
  if (mobile) {
    await page.getByTitle("Close workspace navigator", { exact: true }).click();
  }

  await openNavigator(page, mobile);
  await page
    .getByRole("button", { name: "Manage workspace variables" })
    .click();
  const workspaceVariables = page.getByRole("dialog", {
    name: `Variables for ${workspaceName}`,
  });
  await addValueVariable(
    workspaceVariables,
    1,
    "workspace_source",
    `workspace-${suffix}`,
  );
  await addValueVariable(workspaceVariables, 2, "scope_chain", "workspace");
  await workspaceVariables.getByRole("button", { name: "Save" }).click();
  if (mobile) {
    await page.getByTitle("Close workspace navigator", { exact: true }).click();
  }

  await page.getByRole("button", { name: "Manage environments" }).click();
  const environmentDialog = page.getByRole("dialog", {
    name: "Create environment",
  });
  await environmentDialog
    .getByLabel("Name", { exact: true })
    .fill(environmentName);
  await environmentDialog.getByRole("button", { name: "Add variable" }).click();
  await environmentDialog.getByLabel("Variable name 1").fill("base_url");
  await environmentDialog
    .getByLabel("Variable value 1")
    .fill("http://127.0.0.1:8090");
  await environmentDialog.getByRole("button", { name: "Add variable" }).click();
  await environmentDialog.getByLabel("Variable name 2").fill("source");
  await environmentDialog
    .getByLabel("Variable value 2")
    .fill(`environment-${suffix}`);
  await environmentDialog.getByRole("button", { name: "Add variable" }).click();
  await environmentDialog.getByLabel("Variable name 3").fill("token");
  await environmentDialog.getByLabel("Variable kind 3").click();
  await page
    .getByRole("listbox", { name: "Variable kind 3" })
    .getByRole("option", { name: "Secret", exact: true })
    .click();
  await environmentDialog.getByLabel("Secret value 3").fill(`secret-${suffix}`);
  await addValueVariable(environmentDialog, 4, "scope_chain", "environment");
  await environmentDialog.getByRole("button", { name: "Save" }).click();
  await expect(environmentDialog).toBeHidden();
  await selectMenuOption(page, "Select environment", environmentName);

  await openNavigator(page, mobile);
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
    .getByRole("treeitem", { name: collectionName, exact: true });
  await expect(collection).toBeVisible();
  await collection.click();

  await openCollectionAction(page, collectionName, "Collection properties");
  const propertiesDialog = page.getByRole("dialog", {
    name: "Collection properties",
  });
  await expect(propertiesDialog.getByLabel("Collection name")).toHaveValue(
    collectionName,
  );
  await propertiesDialog
    .getByRole("button", { name: "Add common header" })
    .click();
  await propertiesDialog
    .getByLabel("Header name 1", { exact: true })
    .fill("X-Inherited");
  await propertiesDialog
    .getByLabel("Header value 1", { exact: true })
    .fill(`root-${suffix}`);
  await propertiesDialog.getByRole("tab", { name: "Variables" }).click();
  await addValueVariable(
    propertiesDialog,
    1,
    "collection_source",
    `collection-${suffix}`,
  );
  await addValueVariable(propertiesDialog, 2, "scope_chain", "collection");
  await propertiesDialog.getByRole("button", { name: "Save" }).click();

  await openCollectionAction(page, collectionName, "New subcollection");
  const subcollectionDialog = page.getByRole("dialog", {
    name: "New subcollection",
  });
  await subcollectionDialog
    .getByLabel("Collection name")
    .fill(subcollectionName);
  await subcollectionDialog.getByRole("button", { name: "Create" }).click();
  const subcollection = workspaceTree.getByRole("treeitem", {
    name: subcollectionName,
    exact: true,
  });
  await expect(subcollection).toBeVisible();
  await subcollection.click();

  await openCollectionAction(page, subcollectionName, "New subcollection");
  const leafDialog = page.getByRole("dialog", {
    name: "New subcollection",
  });
  await leafDialog.getByLabel("Collection name").fill(leafCollectionName);
  await leafDialog.getByRole("button", { name: "Create" }).click();
  const leafCollection = workspaceTree.getByRole("treeitem", {
    name: leafCollectionName,
    exact: true,
  });
  await expect(leafCollection).toBeVisible();
  await leafCollection.click();

  await openCollectionAction(page, leafCollectionName, "New request");
  if (mobile) {
    await expect(
      page.getByRole("button", { name: "Open workspace navigator" }),
    ).toBeVisible();
  }
  const draftRevision = page.locator(".draft-revision");
  await expect(draftRevision).toHaveText("Temporary");
  await page.getByLabel("Request name", { exact: true }).fill(requestName);
  await page.getByLabel("Target URL").fill("<<base_url>>/echo");
  await expect(
    page.locator('.url-template-input [data-variable-name="base_url"]'),
  ).toHaveAttribute("data-preview-status", "resolved");
  await inspectTemplateAt(page, "Target URL", 3);
  await expect(page.getByRole("tooltip")).toContainText(
    "http://127.0.0.1:8090",
  );
  await selectMenuOption(page, "HTTP method", "POST");
  const addParameterButton = page.getByRole("button", {
    name: "Add parameter",
  });
  await expect(addParameterButton).toHaveCSS("white-space", "nowrap");
  await addParameterButton.click();
  await page.getByLabel("Query name 1").fill("source");
  await page.getByLabel("Query value 1").fill("<<source>>");
  await addRequestQuery(page, 2, "scope", "<<scope_chain>>");
  await page.getByRole("tab", { name: "Headers 1" }).click();
  await expect(page.getByLabel("Inherited header name 1")).toHaveValue(
    "X-Inherited",
  );
  await expect(page.getByLabel("Inherited header name 1")).toBeDisabled();
  const addHeaderButton = page.getByRole("button", { name: "Add header" });
  await expect(addHeaderButton).toHaveCSS("white-space", "nowrap");
  await addHeaderButton.click();
  await page
    .getByLabel("Header name 1", { exact: true })
    .fill("X-Fixture-Request");
  await page.getByLabel("Header value 1", { exact: true }).fill("<<token>>");
  await expect(
    page.locator('.field-template-input [data-variable-name="token"]'),
  ).toHaveAttribute("data-preview-status", "resolved");
  await inspectTemplateAt(page, "Header value 1", 3);
  await expect(page.getByRole("tooltip")).toContainText("Secret value stored");
  await expect(page.getByRole("tooltip")).not.toContainText(`secret-${suffix}`);
  await page.getByRole("tab", { name: "Body" }).click();
  await page
    .getByLabel("Raw request body")
    .fill(
      "payload-<<source>>-<<workspace_source>>-<<collection_source>>-<<scope_chain>>",
    );
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByRole("status")).toHaveText("In progress");
  await expect(page.locator(".status-code")).toHaveText("201");
  await expect(page.locator(".body-preview")).toContainText(`"method":"POST"`);
  await expect(page.locator(".body-preview")).toContainText(
    `"query":[["source","environment-${suffix}"],["scope","collection"]]`,
  );
  await expect(page.locator(".body-preview")).toContainText(
    `"requestHeader":"secret-${suffix}"`,
  );
  await expect(page.locator(".body-preview")).toContainText(
    `"inheritedHeader":"root-${suffix}"`,
  );
  await expect(page.locator(".body-preview")).toContainText(
    `"body":"payload-environment-${suffix}-workspace-${suffix}-collection-${suffix}-collection"`,
  );
  await expect(draftRevision).toHaveText("Temporary");
  await expect(
    workspaceTree.getByRole("treeitem", {
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

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download response body" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  expect(await readFile(downloadPath, "utf8")).toContain(
    `"body":"payload-environment-${suffix}-workspace-${suffix}-collection-${suffix}-collection"`,
  );

  await page.getByRole("button", { name: "New temporary request" }).click();
  await expect(page.locator(".request-tab")).toHaveCount(2);
  if (mobile) {
    const requestMenuTrigger = page.getByRole("combobox", {
      name: "Open requests",
    });
    await requestMenuTrigger.click();
    const requestMenu = page.getByRole("listbox", { name: "Open requests" });
    await expect(requestMenu.getByRole("option")).toHaveCount(2);
    const requestPopup = requestMenu.locator("..");
    const triggerBox = await requestMenuTrigger.boundingBox();
    const menuBox = await requestPopup.boundingBox();
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
    const requestMenuTrigger = page.getByRole("combobox", {
      name: "Open requests",
    });
    await expect(requestMenuTrigger.locator(".request-tab-method")).toHaveText(
      "GET",
    );
    await expect(requestMenuTrigger.locator(".request-tab-name")).toHaveText(
      `Scratch ${suffix}`,
    );
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
  const destinationCollection = destinationTree.getByRole("treeitem", {
    name: leafCollectionName,
    exact: true,
  });
  await expect(destinationCollection.locator("..")).toHaveClass(/is-selected/u);
  await saveDialog.getByRole("button", { name: "Save" }).click();
  const requestNode = workspaceTree.getByRole("treeitem", {
    name: `POST ${requestName}`,
    exact: true,
  });
  await expect(requestNode).toHaveClass(/is-selected/u);
  await expect(subcollection.locator("..")).not.toHaveClass(/is-selected/u);
  await expect(draftRevision).toHaveText("Draft 0");

  await page.getByRole("button", { name: "Manage request variables" }).click();
  const requestVariables = page.getByRole("dialog", {
    name: `Variables for ${requestName}`,
  });
  await addValueVariable(requestVariables, 1, "source", `request-${suffix}`);
  await addValueVariable(requestVariables, 2, "scope_chain", "request");
  await requestVariables.getByRole("button", { name: "Save" }).click();

  await page.reload();
  await openNavigator(page, mobile);
  await selectMenuOption(page, "Workspace", workspaceName);
  await expect(page.getByLabel("Select environment")).toHaveAttribute(
    "data-value",
    /.+/u,
  );
  await workspaceTree
    .getByRole("treeitem", { name: collectionName, exact: true })
    .click();
  await workspaceTree
    .getByRole("treeitem", { name: subcollectionName, exact: true })
    .click();
  await workspaceTree
    .getByRole("treeitem", { name: leafCollectionName, exact: true })
    .click();
  await workspaceTree
    .getByRole("treeitem", { name: `POST ${requestName}`, exact: true })
    .click();
  if (mobile) {
    await expect(
      page.getByRole("button", { name: "Open workspace navigator" }),
    ).toBeVisible();
  }

  await expect(page.getByLabel("Request name", { exact: true })).toHaveValue(
    requestName,
  );
  await expect(page.getByLabel("Target URL")).toHaveValue("<<base_url>>/echo");
  await expect(page.getByLabel("HTTP method")).toHaveAttribute(
    "data-value",
    "POST",
  );
  await page.getByRole("tab", { name: "Headers 2" }).click();
  await expect(page.getByLabel("Inherited header name 1")).toHaveValue(
    "X-Inherited",
  );
  await expect(page.getByLabel("Inherited header name 1")).toBeDisabled();
  await expect(page.getByLabel("Inherited header value 1")).toHaveValue(
    `root-${suffix}`,
  );
  await page.getByRole("tab", { name: "Body" }).click();
  await expect(page.getByLabel("Raw request body")).toHaveValue(
    "payload-<<source>>-<<workspace_source>>-<<collection_source>>-<<scope_chain>>",
  );
  await inspectTemplateAt(page, "Raw request body", 10);
  await expect(page.getByRole("tooltip")).toContainText(
    `Request: ${requestName}`,
  );
  await expect(page.getByRole("tooltip")).toContainText(`request-${suffix}`);
  await expect(draftRevision).toHaveText("Draft 0");

  await openNavigator(page, mobile);
  const selectedLeaf = workspaceTree.getByRole("treeitem", {
    name: leafCollectionName,
    exact: true,
  });
  await selectedLeaf.click();
  await expect(selectedLeaf.locator("..")).toHaveClass(/is-selected/u);
  await expect(
    workspaceTree.getByRole("treeitem", {
      name: `POST ${requestName}`,
      exact: true,
    }),
  ).not.toHaveClass(/is-selected/u);
  if (mobile) {
    await page.getByTitle("Close workspace navigator", { exact: true }).click();
  }
  await expect(
    page.getByRole("heading", { name: "Select a request" }),
  ).toBeVisible();
  await openNavigator(page, mobile);
  await workspaceTree
    .getByRole("treeitem", { name: `POST ${requestName}`, exact: true })
    .click();

  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("status")).toHaveText("In progress");
  await expect(page.locator(".status-code")).toHaveText("201");
  await expect(page.locator(".body-preview")).toContainText(
    `"inheritedHeader":"root-${suffix}"`,
  );
  await expect(page.locator(".body-preview")).toContainText(
    `"requestHeader":"secret-${suffix}"`,
  );
  await expect(page.locator(".body-preview")).toContainText(
    `["source","request-${suffix}"],["scope","request"]`,
  );
  await expect(page.locator(".body-preview")).toContainText(
    `"body":"payload-request-${suffix}-workspace-${suffix}-collection-${suffix}-request"`,
  );
  await expect(draftRevision).toHaveText("Draft 0");

  const freshRequestName = `Fresh save ${suffix}`;
  await page.getByRole("button", { name: "New temporary request" }).click();
  await page.getByLabel("Target URL").fill("https://example.test/fresh");
  const freshSaveButton = page.getByRole("button", {
    name: "Save",
    exact: true,
  });
  await expect(freshSaveButton).toBeEnabled();
  await freshSaveButton.click();
  const freshSaveDialog = page.getByRole("dialog", { name: "Save request" });
  await freshSaveDialog.getByLabel("Saved request name").fill(freshRequestName);
  await expect(
    freshSaveDialog
      .getByRole("treeitem", {
        name: collectionName,
        exact: true,
      })
      .locator(".."),
  ).toHaveClass(/is-selected/u);
  await freshSaveDialog.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".draft-revision")).toHaveText("Draft 0");
  await expect(page.getByLabel("Request name", { exact: true })).toHaveValue(
    freshRequestName,
  );
});

/** Opens one row-local collection action through its accessible menu. */
async function openCollectionAction(
  page: Page,
  collectionName: string,
  actionName: string,
): Promise<void> {
  const label = `More actions for ${collectionName}`;
  await page.getByRole("button", { name: label }).click();
  await page
    .getByRole("menu", { name: label })
    .getByRole("menuitem", { name: actionName, exact: true })
    .click();
}

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

/** Selects one option from an application-rendered select menu. */
async function selectMenuOption(
  page: Page,
  label: string,
  option: string,
): Promise<void> {
  await page.getByLabel(label, { exact: true }).click();
  await page
    .getByRole("listbox", { name: label })
    .getByRole("option", { name: option, exact: true })
    .click();
}

/** Focuses one placeholder position so its accessible preview becomes visible. */
async function inspectTemplateAt(
  page: Page,
  label: string,
  position: number,
): Promise<void> {
  await page.getByLabel(label, { exact: true }).evaluate((element, caret) => {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      element.focus();
      element.setSelectionRange(caret, caret);
      element.dispatchEvent(new Event("select", { bubbles: true }));
    }
  }, position);
}

/** Adds one ordinary variable to an open environment or scope profile dialog. */
async function addValueVariable(
  dialog: Locator,
  index: number,
  name: string,
  value: string,
): Promise<void> {
  await dialog.getByRole("button", { name: "Add variable" }).click();
  await dialog.getByLabel(`Variable name ${index}`).fill(name);
  await dialog.getByLabel(`Variable value ${index}`).fill(value);
}

/** Adds one structured query field through the active request editor. */
async function addRequestQuery(
  page: Page,
  index: number,
  name: string,
  value: string,
): Promise<void> {
  await page.getByRole("button", { name: "Add parameter" }).click();
  await page.getByLabel(`Query name ${index}`).fill(name);
  await page.getByLabel(`Query value ${index}`).fill(value);
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
