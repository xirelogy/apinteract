// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import type { EnvironmentEditorTab } from "../src/model/domain/application";
import EnvironmentManager from "../src/view/presentation/features/EnvironmentManager.vue";

const workspaceId = "019fa8be-a510-76b9-b73b-69f4c7af7876";
const environmentId = "019fa8be-a510-76b9-b73b-69f4c7af7875";
let showModalDescriptor: PropertyDescriptor | undefined;
let closeDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  showModalDescriptor = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    "showModal",
  );
  closeDescriptor = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    "close",
  );
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    /** Simulates opening a native dialog in jsdom. */
    value(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    /** Simulates closing a native dialog and publishing its lifecycle event. */
    value(this: HTMLDialogElement): void {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    },
  });
});

afterEach(() => {
  if (showModalDescriptor === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  } else {
    Object.defineProperty(
      HTMLDialogElement.prototype,
      "showModal",
      showModalDescriptor,
    );
  }
  if (closeDescriptor === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  } else {
    Object.defineProperty(
      HTMLDialogElement.prototype,
      "close",
      closeDescriptor,
    );
  }
  document.body.replaceChildren();
});

/** Creates the localization plugin used by presentation tests. */
function i18n() {
  return createI18n({
    legacy: false,
    locale: "en-US",
    messages: { "en-US": enUsMessages },
  });
}

/** Creates one saved environment editor tab. */
function savedTab(): EnvironmentEditorTab {
  const environment = {
    environmentId,
    workspaceId,
    name: "Development",
    revision: 2,
    includedEnvironments: [],
    variables: [
      {
        variableId: "019fa8be-a510-76b9-b73b-69f4c7af7877",
        name: "token",
        kind: "secret" as const,
        hasValue: true,
        secretVersion: 4,
      },
    ],
    inheritedVariables: [],
  };
  const draft = {
    name: environment.name,
    variables: [
      {
        variableId: "019fa8be-a510-76b9-b73b-69f4c7af7877",
        name: "token",
        kind: "secret" as const,
      },
    ],
    includedEnvironmentIds: [],
  };
  return {
    kind: "environment",
    tabId: "019fa8be-a510-76b9-b73b-69f4c7af7878",
    workspaceId,
    environment,
    draft,
    baseline: draft,
    busy: false,
  };
}

describe("EnvironmentManager", () => {
  it("opens environment editors from the non-blocking toolbar", async () => {
    const stagingId = "019fa8be-a510-76b9-b73b-69f4c7af7879";
    const wrapper = mount(EnvironmentManager, {
      attachTo: document.body,
      props: {
        environments: [
          { environmentId, name: "Development", revision: 2 },
          { environmentId: stagingId, name: "Staging", revision: 1 },
        ],
        selectedEnvironmentId: environmentId,
        editorTab: null,
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n()] },
    });

    await wrapper
      .get('button[aria-label="Manage environments"]')
      .trigger("click");
    await flushPromises();
    const menuItems = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    expect(menuItems.map((item) => item.textContent)).toEqual([
      "Edit Development",
      "Create new environment",
      "Edit Staging",
    ]);
    menuItems[1]?.click();
    await flushPromises();
    expect(wrapper.emitted("openEditor")).toEqual([[null]]);
    expect(wrapper.find(".environment-dialog").exists()).toBe(false);
    wrapper.unmount();
  });

  it("edits an environment in a workbench panel and keeps it open after save", async () => {
    const tab = savedTab();
    const wrapper = mount(EnvironmentManager, {
      attachTo: document.body,
      props: {
        environments: [{ environmentId, name: "Development", revision: 2 }],
        selectedEnvironmentId: environmentId,
        editorTab: tab,
        showToolbar: false,
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n()] },
    });

    expect(wrapper.get(".environment-dialog").element.tagName).toBe("SECTION");
    const title = wrapper.get<HTMLInputElement>("#environment-dialog-title");
    expect(title.element.value).toBe("Development");
    expect(title.classes()).toContain("request-name-input");
    expect(wrapper.find(".resource-editor-title .lucide-layers").exists()).toBe(
      true,
    );
    const saveButton = wrapper.get('button[aria-label="Save"]');
    expect(saveButton.attributes("form")).toBe("environment-editor-form");
    expect(saveButton.classes()).toContain("primary-button");
    await wrapper.get("input[required]").setValue("Local development");
    await saveButton.trigger("click");
    expect(wrapper.emitted("saveEditor")).toEqual([[tab.tabId]]);
    expect(wrapper.find(".environment-dialog").exists()).toBe(true);
    const change = wrapper.emitted("change")?.at(-1);
    expect(change?.[0]).toBe(tab.tabId);
    expect(change?.[1]).toMatchObject({ name: "Local development" });
    wrapper.unmount();
  });

  it("preserves stored secrets without rendering or resubmitting plaintext", () => {
    const tab = savedTab();
    const wrapper = mount(EnvironmentManager, {
      props: {
        environments: [{ environmentId, name: "Development", revision: 2 }],
        selectedEnvironmentId: environmentId,
        editorTab: tab,
        showToolbar: false,
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n()] },
    });

    const secretInput = wrapper.get('input[aria-label="Secret value 1"]');
    expect((secretInput.element as HTMLInputElement).value).toBe("");
    expect(wrapper.text()).not.toContain("top-secret-token");
    wrapper.unmount();
  });

  it("keeps destructive environment confirmation modal", async () => {
    const tab = savedTab();
    const wrapper = mount(EnvironmentManager, {
      attachTo: document.body,
      props: {
        environments: [{ environmentId, name: "Development", revision: 2 }],
        selectedEnvironmentId: environmentId,
        editorTab: tab,
        showToolbar: false,
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n()] },
    });

    const deleteButton = wrapper.get('button[aria-label="Delete"]');
    expect(deleteButton.classes()).toContain("danger-outline-button");
    await deleteButton.trigger("click");
    await flushPromises();
    const confirmation = wrapper.get(".environment-delete-dialog");
    expect(confirmation.attributes()).toHaveProperty("open");
    await confirmation.get(".danger-button").trigger("click");
    expect(wrapper.emitted("delete")).toEqual([[environmentId, 2]]);
    wrapper.unmount();
  });
});
