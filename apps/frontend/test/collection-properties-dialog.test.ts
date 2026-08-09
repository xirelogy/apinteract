// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import CollectionPropertiesDialog from "../src/view/presentation/features/CollectionPropertiesDialog.vue";
import WorkspacePropertiesDialog from "../src/view/presentation/features/WorkspacePropertiesDialog.vue";

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
    /** Simulates native top-layer opening for the collection dialog test. */
    value(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    /** Simulates native closure and its lifecycle event for the dialog test. */
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

describe("CollectionPropertiesDialog", () => {
  it("edits the name, common headers, and variables together", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(CollectionPropertiesDialog, {
      attachTo: document.body,
      props: {
        collection: {
          collectionId: "019fa8be-a510-76b9-b73b-69f4c7af7875",
          workspaceId: "019fa8be-a510-76b9-b73b-69f4c7af7876",
          parentCollectionId: null,
          name: "Examples",
          headers: [],
          effectiveHeaders: [],
          revision: 0,
        },
        variableProfile: {
          workspaceId: "019fa8be-a510-76b9-b73b-69f4c7af7876",
          scopeKind: "collection",
          scopeId: "019fa8be-a510-76b9-b73b-69f4c7af7875",
          scopeName: "Examples",
          revision: 0,
          variables: [],
        },
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    expect(wrapper.find(".resource-dialog-context").exists()).toBe(false);
    await wrapper
      .get('input[aria-label="Collection name"]')
      .setValue("Renamed examples");
    await wrapper.get("button.add-field-button").trigger("click");
    await wrapper.get('input[aria-label="Header name 1"]').setValue("X-Team");
    await wrapper
      .get('input[aria-label="Header value 1"]')
      .setValue("platform");
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toContain(
      "Common headers",
    );
    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().includes("Variables"))
      ?.trigger("click");
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toContain(
      "Variables",
    );
    expect(
      wrapper
        .findAll('[role="tabpanel"]')
        .find((panel) =>
          panel.attributes("aria-labelledby")?.includes("headers"),
        )
        ?.attributes("hidden"),
    ).toBeDefined();
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Add variable"))
      ?.trigger("click");
    await wrapper
      .get('input[aria-label="Variable name 1"]')
      .setValue("base_url");
    await wrapper
      .get('input[aria-label="Variable value 1"]')
      .setValue("https://collection.test");
    await wrapper.get('button[type="submit"]').trigger("submit");

    expect(wrapper.emitted("save")).toEqual([
      [
        "Renamed examples",
        [{ name: "X-Team", value: "platform", enabled: true }],
        [
          {
            name: "base_url",
            kind: "value",
            value: "https://collection.test",
          },
        ],
      ],
    ]);
    wrapper.unmount();
  });
});

describe("WorkspacePropertiesDialog", () => {
  it("edits root common headers and variables together", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const workspaceId = "019fa8be-a510-76b9-b73b-69f4c7af7876";
    const wrapper = mount(WorkspacePropertiesDialog, {
      attachTo: document.body,
      props: {
        workspace: {
          workspaceId,
          name: "Platform",
          role: "owner",
          headers: [],
          revision: 0,
        },
        variableProfile: {
          workspaceId,
          scopeKind: "workspace",
          scopeId: workspaceId,
          scopeName: "Platform",
          revision: 0,
          variables: [],
        },
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    expect(wrapper.find(".resource-dialog-context").exists()).toBe(false);
    await wrapper.get("button.add-field-button").trigger("click");
    await wrapper
      .get('input[aria-label="Header name 1"]')
      .setValue("X-Workspace");
    await wrapper
      .get('input[aria-label="Header value 1"]')
      .setValue("platform");
    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().includes("Variables"))
      ?.trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Add variable"))
      ?.trigger("click");
    await wrapper.get('input[aria-label="Variable name 1"]').setValue("team");
    await wrapper
      .get('input[aria-label="Variable value 1"]')
      .setValue("platform");
    await wrapper.get('button[type="submit"]').trigger("submit");

    expect(wrapper.emitted("save")).toEqual([
      [
        "Platform",
        [{ name: "X-Workspace", value: "platform", enabled: true }],
        [{ name: "team", kind: "value", value: "platform" }],
      ],
    ]);
    wrapper.unmount();
  });
});
