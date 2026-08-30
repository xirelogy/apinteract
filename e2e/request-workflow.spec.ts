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
  await page.getByRole("button", { name: "Workspace properties" }).click();
  await closeNavigator(page, mobile);
  const workspaceProperties = page.getByRole("region", {
    name: workspaceName,
  });
  await expect(workspaceProperties.getByLabel("Workspace name")).toHaveValue(
    workspaceName,
  );
  await workspaceProperties
    .getByLabel("Header name 1", { exact: true })
    .fill("X-Workspace");
  await workspaceProperties
    .getByLabel("Header value 1", { exact: true })
    .fill(`workspace-header-${suffix}`);
  await workspaceProperties.getByRole("tab", { name: "Variables" }).click();
  await addValueVariable(
    workspaceProperties,
    1,
    "workspace_source",
    `workspace-${suffix}`,
  );
  await addValueVariable(workspaceProperties, 2, "scope_chain", "workspace");
  const workspaceSave = workspaceProperties.getByRole("button", {
    name: "Save",
  });
  await workspaceSave.click();
  await expect(page.getByLabel("Unsaved changes")).toHaveCount(0);
  const closeWorkspace = page.getByRole("button", {
    name: `Close ${workspaceName}`,
  });
  await expect(closeWorkspace).toBeVisible();
  await closeWorkspace.click();

  await page.getByRole("button", { name: "Manage environments" }).click();
  await page.getByRole("menuitem", { name: "Create new environment" }).click();
  const environmentEditor = page.locator(".environment-dialog");
  await environmentEditor
    .getByLabel("Name", { exact: true })
    .fill(environmentName);
  await environmentEditor.getByLabel("Variable name 1").fill("base_url");
  await environmentEditor
    .getByLabel("Variable value 1")
    .fill("http://127.0.0.1:8090");
  await environmentEditor.getByLabel("Variable name 2").fill("source");
  await environmentEditor
    .getByLabel("Variable value 2")
    .fill(`environment-${suffix}`);
  await environmentEditor.getByLabel("Variable name 3").fill("token");
  await environmentEditor.getByLabel("Variable kind 3").click();
  await page
    .getByRole("listbox", { name: "Variable kind 3" })
    .getByRole("option", { name: "Secret", exact: true })
    .click();
  await environmentEditor.getByLabel("Secret value 3").fill(`secret-${suffix}`);
  await addValueVariable(environmentEditor, 4, "scope_chain", "environment");
  await environmentEditor.getByRole("button", { name: "Save" }).click();
  const closeEnvironment = page.getByRole("button", {
    name: `Close ${environmentName}`,
  });
  await expect(closeEnvironment).toBeVisible();
  await selectMenuOption(page, "Select environment", environmentName);
  await closeEnvironment.click();

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

  await openCollectionAction(page, collectionName, "Collection properties");
  await closeNavigator(page, mobile);
  const collectionProperties = page.getByRole("region", {
    name: collectionName,
  });
  await expect(collectionProperties.getByLabel("Collection name")).toHaveValue(
    collectionName,
  );
  await collectionProperties
    .getByLabel("Header name 1", { exact: true })
    .fill("X-Inherited");
  await collectionProperties
    .getByLabel("Header value 1", { exact: true })
    .fill(`root-${suffix}`);
  await collectionProperties.getByRole("tab", { name: "Variables" }).click();
  await addValueVariable(
    collectionProperties,
    1,
    "collection_source",
    `collection-${suffix}`,
  );
  await addValueVariable(collectionProperties, 2, "scope_chain", "collection");
  const collectionSave = collectionProperties.getByRole("button", {
    name: "Save",
  });
  await collectionSave.click();
  const closeCollection = page.getByRole("button", {
    name: `Close ${collectionName}`,
  });
  await expect(closeCollection).toBeVisible();
  await closeCollection.click();

  await openNavigator(page, mobile);
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

  await openCollectionAction(page, leafCollectionName, "New request");
  if (mobile) {
    await expect(
      page.getByRole("button", { name: "Open workspace navigator" }),
    ).toBeVisible();
  }
  await expect(page.locator(".draft-revision")).toHaveCount(0);
  await page.getByLabel("Request name", { exact: true }).fill(requestName);
  await page.getByLabel("Request path").fill("<<base_url>>/echo");
  await expect(
    page.locator('.url-template-input [data-variable-name="base_url"]'),
  ).toHaveAttribute("data-preview-status", "resolved");
  await inspectTemplateAt(page, "Request path", 3);
  await expect(page.getByRole("tooltip")).toContainText(
    "http://127.0.0.1:8090",
  );
  await selectMenuOption(page, "HTTP method", "POST");
  await page.getByLabel("Query name 1").fill("source");
  await page.getByLabel("Query value 1").fill("<<source>>");
  await addRequestQuery(page, 2, "scope", "<<scope_chain>>");
  await page.getByRole("tab", { name: "Headers 2" }).click();
  await expect(page.getByLabel("Inherited header name 1")).toHaveValue(
    "X-Workspace",
  );
  await expect(page.getByLabel("Inherited header value 1")).toHaveValue(
    `workspace-header-${suffix}`,
  );
  await expect(page.getByLabel("Inherited header name 2")).toHaveValue(
    "X-Inherited",
  );
  await expect(page.getByLabel("Inherited header name 2")).toBeDisabled();
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
  if (!mobile) {
    await selectMenuOption(page, "Content type", "JSON");
    const bodyPanel = page.locator(".request-body-editor");
    const bodyType = page.getByRole("combobox", {
      name: "Content type",
      exact: true,
    });
    const mediaType = page.getByLabel("Content type override");
    const formatBody = page.getByRole("button", { name: "Format body" });
    await expect(formatBody).toBeVisible();
    const bodyContent = page.locator(".wire-request-body-content");
    const [
      panelBox,
      bodyTypeBox,
      mediaTypeBox,
      formatBox,
      contentBox,
      editorBox,
      panelPaddingBottom,
    ] = await Promise.all([
      bodyPanel.boundingBox(),
      bodyType.boundingBox(),
      mediaType.boundingBox(),
      formatBody.boundingBox(),
      bodyContent.boundingBox(),
      page.locator(".body-code-editor").boundingBox(),
      bodyPanel.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).paddingBottom),
      ),
    ]);
    expect(panelBox).not.toBeNull();
    expect(bodyTypeBox).not.toBeNull();
    expect(mediaTypeBox).not.toBeNull();
    expect(formatBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    expect(editorBox).not.toBeNull();
    expect(Math.abs(bodyTypeBox!.y - mediaTypeBox!.y)).toBeLessThan(3);
    expect(Math.abs(bodyTypeBox!.y - formatBox!.y)).toBeLessThan(3);
    expect(Math.abs(editorBox!.height - contentBox!.height)).toBeLessThan(3);
    expect(
      Math.abs(
        editorBox!.y +
          editorBox!.height -
          (panelBox!.y + panelBox!.height - panelPaddingBottom),
      ),
    ).toBeLessThan(3);
    await expect(page.locator(".body-code-editor .cm-scroller")).toHaveCSS(
      "overflow-y",
      "auto",
    );
  }
  await selectMenuOption(page, "Content type", "Plain text");
  await page
    .getByLabel("Raw request body")
    .fill(
      "payload-<<source>>-<<workspace_source>>-<<collection_source>>-<<scope_chain>>",
    );
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByRole("status")).toHaveText("In progress");
  await expect(page.locator(".status-code")).toHaveText("201");
  await page
    .getByRole("tablist", { name: "Response details" })
    .getByRole("tab", { name: "Raw", exact: true })
    .click();
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
  await expect(page.getByLabel("Raw response body")).toBeVisible();
  await expect(
    page.locator(".body-preview .cm-lineNumbers .cm-gutterElement"),
  ).not.toHaveCount(0);
  await page
    .getByRole("tablist", { name: "Response details" })
    .getByRole("tab", { name: "JSON", exact: true })
    .click();
  const formattedJson = page.getByLabel("Formatted JSON response body");
  await expect(formattedJson).toBeVisible();
  await expect(formattedJson).toContainText('"method": "POST"');
  await expect(formattedJson.locator(".cm-line")).not.toHaveCount(1);
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
      name: "Open tabs",
    });
    await requestMenuTrigger.click();
    const requestMenu = page.getByRole("listbox", { name: "Open tabs" });
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
      name: "Open tabs",
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
  await expect(requestNode).toHaveAttribute("aria-selected", "true");
  await expect(subcollection).not.toHaveAttribute("aria-selected", "true");

  await page.getByRole("tab", { name: "Variables" }).click();
  const requestVariables = page.locator(".request-variables-editor");
  await addValueVariable(requestVariables, 1, "source", `request-${suffix}`);
  await addValueVariable(requestVariables, 2, "scope_chain", "request");
  await page
    .locator(".request-editor")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: `Close ${requestName}` }),
  ).toBeVisible();
  await expect
    .poll(() => requestTabIsPersisted(page, requestName, `request-${suffix}`))
    .toBe(true);

  await page.reload();
  await openNavigator(page, mobile);
  await expect(
    page.getByRole("combobox", { name: "Workspace", exact: true }),
  ).toContainText(workspaceName);
  await expect(page.getByLabel("Select environment")).toHaveAttribute(
    "data-value",
    /.+/u,
  );
  await workspaceTree
    .getByRole("button", { name: `Expand ${collectionName}` })
    .click();
  await workspaceTree
    .getByRole("button", { name: `Expand ${subcollectionName}` })
    .click();
  await workspaceTree
    .getByRole("button", { name: `Expand ${leafCollectionName}` })
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
  await expect(page.getByLabel("Request path")).toHaveValue(
    "<<base_url>>/echo",
  );
  await expect(page.getByLabel("HTTP method")).toHaveAttribute(
    "data-value",
    "POST",
  );
  await page.getByRole("tab", { name: "Headers 4" }).click();
  await expect(page.getByLabel("Inherited header name 1")).toHaveValue(
    "X-Workspace",
  );
  await expect(page.getByLabel("Inherited header value 1")).toHaveValue(
    `workspace-header-${suffix}`,
  );
  await expect(page.getByLabel("Inherited header name 2")).toHaveValue(
    "X-Inherited",
  );
  await expect(page.getByLabel("Inherited header name 2")).toBeDisabled();
  await expect(page.getByLabel("Inherited header value 2")).toHaveValue(
    `root-${suffix}`,
  );
  await page.getByRole("tab", { name: "Body" }).click();
  await expect(page.getByLabel("Raw request body")).toHaveText(
    "payload-<<source>>-<<workspace_source>>-<<collection_source>>-<<scope_chain>>",
  );

  await openNavigator(page, mobile);
  const selectedLeaf = workspaceTree.getByRole("treeitem", {
    name: leafCollectionName,
    exact: true,
  });
  await selectedLeaf.click();
  await expect(selectedLeaf).toHaveAttribute("aria-selected", "true");
  await expect(
    workspaceTree.getByRole("treeitem", {
      name: `POST ${requestName}`,
      exact: true,
    }),
  ).not.toHaveAttribute("aria-selected", "true");
  if (mobile) {
    await page.getByTitle("Close workspace navigator", { exact: true }).click();
  }
  await expect(
    page.getByRole("region", { name: leafCollectionName }),
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
  await expect(page.locator(".draft-revision")).toHaveCount(0);
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

/** Reports whether IndexedDB contains the latest clean saved-request snapshot. */
async function requestTabIsPersisted(
  page: Page,
  requestName: string,
  expectedSource: string,
): Promise<boolean> {
  return page.evaluate(
    async ({ expectedSource, requestName }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("apinteract-local-requests");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error ?? new Error("Could not open request storage"));
      });
      try {
        const records = await new Promise<unknown[]>((resolve, reject) => {
          const request = database
            .transaction("request-tabs", "readonly")
            .objectStore("request-tabs")
            .getAll();
          request.onsuccess = () => resolve(request.result as unknown[]);
          request.onerror = () =>
            reject(
              request.error ?? new Error("Could not read persisted requests"),
            );
        });
        return records.some((record) => {
          if (
            typeof record !== "object" ||
            record === null ||
            !("payload" in record) ||
            typeof record.payload !== "string"
          ) {
            return false;
          }
          const snapshot = JSON.parse(record.payload) as {
            readonly requestId?: unknown;
            readonly draftDirty?: unknown;
            readonly variableDirty?: unknown;
            readonly draft?: { readonly name?: unknown };
            readonly variableDraft?: readonly {
              readonly name?: unknown;
              readonly value?: unknown;
            }[];
          };
          return (
            typeof snapshot.requestId === "string" &&
            snapshot.draftDirty === false &&
            snapshot.variableDirty === false &&
            snapshot.draft?.name === requestName &&
            snapshot.variableDraft?.some(
              (variable) =>
                variable.name === "source" && variable.value === expectedSource,
            ) === true
          );
        });
      } finally {
        database.close();
      }
    },
    { expectedSource, requestName },
  );
}

/** Opens the overlay navigator only for the mobile browser project. */
async function openNavigator(page: Page, mobile: boolean): Promise<void> {
  if (mobile) {
    await page
      .getByRole("button", { name: "Open workspace navigator" })
      .click();
  }
}

/** Closes the overlay navigator only for the mobile browser project. */
async function closeNavigator(page: Page, mobile: boolean): Promise<void> {
  if (mobile) {
    await page.getByTitle("Close workspace navigator", { exact: true }).click();
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
  await dialog.getByLabel(`Variable name ${index}`, { exact: true }).fill(name);
  await dialog
    .getByLabel(`Variable value ${index}`, { exact: true })
    .fill(value);
}

/** Adds one structured query field through the active request editor. */
async function addRequestQuery(
  page: Page,
  index: number,
  name: string,
  value: string,
): Promise<void> {
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
