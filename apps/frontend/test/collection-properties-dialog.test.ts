// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  it("previews variables in target prefixes and common headers", async () => {
    vi.useFakeTimers();
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
          pathPrefix: "https://<<host>>",
          inheritedTarget: "https://<<parent_host>>/root",
          effectivePath: "https://<<host>>",
          headers: [
            { name: "Authorization", value: "Bearer <<token>>", enabled: true },
          ],
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
        variablePreviews: [
          {
            name: "parent_host",
            status: "resolved",
            declaredKind: "value",
            effectiveKind: "value",
            aliasTarget: null,
            value: "parent.example.test",
            secretVersion: null,
            diagnostic: null,
            source: {
              scope: "workspace",
              scopeId: "019fa8be-a510-76b9-b73b-69f4c7af7876",
              scopeName: "Workspace",
              revision: 1,
            },
          },
          {
            name: "host",
            status: "resolved",
            declaredKind: "value",
            effectiveKind: "value",
            aliasTarget: null,
            value: "api.example.test",
            secretVersion: null,
            diagnostic: null,
            source: {
              scope: "workspace",
              scopeId: "019fa8be-a510-76b9-b73b-69f4c7af7876",
              scopeName: "Workspace",
              revision: 1,
            },
          },
          {
            name: "token",
            status: "resolved",
            declaredKind: "secret",
            effectiveKind: "secret",
            aliasTarget: null,
            value: null,
            secretVersion: 1,
            diagnostic: null,
            source: {
              scope: "environment",
              scopeId: "019fa8be-a510-76b9-b73b-69f4c7af7877",
              scopeName: "Development",
              revision: 1,
            },
          },
        ],
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(wrapper.emitted("preview")).toEqual([
      [["parent_host", "host", "token"]],
    ]);
    expect(wrapper.findAll('[data-preview-status="resolved"]')).toHaveLength(3);
    const inheritedPrefix = wrapper.get<HTMLInputElement>(
      'input[aria-label="Inherited target"]',
    );
    expect(inheritedPrefix.element.value).toBe("https://<<parent_host>>/root/");
    expect(inheritedPrefix.attributes("readonly")).toBeDefined();
    expect(
      wrapper.get(".inherited-target-input").attributes("style"),
    ).toContain("width: 33ch");
    const targetPrefix = wrapper.get<HTMLInputElement>(
      'input[aria-label="Target prefix"]',
    );
    targetPrefix.element.setSelectionRange(11, 11);
    await targetPrefix.trigger("focus");
    await targetPrefix.trigger("keyup");
    expect(wrapper.get('[role="tooltip"]').text()).toContain(
      "api.example.test",
    );

    wrapper.unmount();
    vi.useRealTimers();
  });

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
          pathPrefix: "",
          inheritedTarget: "",
          effectivePath: "",
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
        variablePreviews: [],
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    expect(wrapper.find(".resource-dialog-context").exists()).toBe(false);
    await wrapper
      .get('input[aria-label="Collection name"]')
      .setValue("Renamed examples");
    const collectionHeader = wrapper.get('input[aria-label="Header name 1"]');
    expect(collectionHeader.attributes("placeholder")).toBe(
      "Add common header",
    );
    expect(
      wrapper.get(".request-field-row .new-row-marker").element.tagName,
    ).toBe("SPAN");
    await collectionHeader.setValue("X-Team");
    expect(
      wrapper
        .get('input[aria-label="Header name 2"]')
        .attributes("placeholder"),
    ).toBe("Add common header");
    await wrapper
      .get('input[aria-label="Header value 1"]')
      .setValue("platform");
    await wrapper
      .get('input[aria-label="Target prefix"]')
      .setValue("/v1/examples");
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
    const collectionVariable = wrapper.get(
      'input[aria-label="Variable name 1"]',
    );
    expect(collectionVariable.attributes("placeholder")).toBe("Add variable");
    await collectionVariable.setValue("base_url");
    expect(
      wrapper
        .get('input[aria-label="Variable name 2"]')
        .attributes("placeholder"),
    ).toBe("Add variable");
    await wrapper
      .get('input[aria-label="Variable value 1"]')
      .setValue("https://collection.test");
    await wrapper.get('button[type="submit"]').trigger("submit");

    expect(wrapper.emitted("save")).toEqual([
      [
        "Renamed examples",
        "/v1/examples",
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

  it("confirms collection deletion from the header action menu", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const collectionId = "019fa8be-a510-76b9-b73b-69f4c7af7875";
    const wrapper = mount(CollectionPropertiesDialog, {
      attachTo: document.body,
      props: {
        collection: {
          collectionId,
          workspaceId: "019fa8be-a510-76b9-b73b-69f4c7af7876",
          parentCollectionId: null,
          name: "Examples",
          pathPrefix: "",
          inheritedTarget: "",
          effectivePath: "",
          headers: [],
          effectiveHeaders: [],
          revision: 3,
        },
        variableProfile: {
          workspaceId: "019fa8be-a510-76b9-b73b-69f4c7af7876",
          scopeKind: "collection",
          scopeId: collectionId,
          scopeName: "Examples",
          revision: 0,
          variables: [],
        },
        variablePreviews: [],
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    await wrapper
      .get('button[aria-label="More actions for Examples"]')
      .trigger("click");
    await flushPromises();
    const deleteMenuItem = wrapper.get('[role="menuitem"]');
    expect(deleteMenuItem.text()).toBe("Delete collection");
    expect(deleteMenuItem.attributes("data-variant")).toBe("danger");
    await deleteMenuItem.trigger("click");
    await flushPromises();

    const confirmation = wrapper.get(".collection-delete-dialog");
    expect(confirmation.attributes()).toHaveProperty("open");
    expect(confirmation.get("h2").text()).toBe("Delete collection?");
    expect(confirmation.text()).toContain(
      "“Examples” and all nested collections, requests, and variables",
    );
    expect(wrapper.emitted("delete")).toBeUndefined();
    await confirmation.get(".danger-button").trigger("click");
    expect(wrapper.emitted("delete")).toEqual([[collectionId, 3]]);
    wrapper.unmount();
  });
});

describe("WorkspacePropertiesDialog", () => {
  it("previews variables in the workspace base URL", async () => {
    vi.useFakeTimers();
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
          baseUrl: "https://<<host>>",
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
        variablePreviews: [
          {
            name: "host",
            status: "resolved",
            declaredKind: "value",
            effectiveKind: "value",
            aliasTarget: null,
            value: "api.example.test",
            secretVersion: null,
            diagnostic: null,
            source: {
              scope: "workspace",
              scopeId: workspaceId,
              scopeName: "Platform",
              revision: 1,
            },
          },
        ],
        canEdit: true,
        canDelete: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(wrapper.emitted("preview")).toEqual([[["host"]]]);
    expect(
      wrapper.get('[data-variable-name="host"]').attributes(),
    ).toHaveProperty("data-preview-status", "resolved");
    const baseUrl = wrapper.get<HTMLInputElement>(
      'input[aria-label="Base URL"]',
    );
    baseUrl.element.setSelectionRange(11, 11);
    await baseUrl.trigger("focus");
    await baseUrl.trigger("keyup");
    expect(wrapper.get('[role="tooltip"]').text()).toContain(
      "api.example.test",
    );

    wrapper.unmount();
    vi.useRealTimers();
  });

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
          baseUrl: "",
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
        variablePreviews: [],
        canEdit: true,
        canDelete: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    expect(wrapper.find(".resource-dialog-context").exists()).toBe(false);
    const workspaceHeader = wrapper.get('input[aria-label="Header name 1"]');
    expect(workspaceHeader.attributes("placeholder")).toBe("Add common header");
    await workspaceHeader.setValue("X-Workspace");
    await wrapper
      .get('input[aria-label="Header value 1"]')
      .setValue("platform");
    await wrapper
      .get('input[aria-label="Base URL"]')
      .setValue("https://api.example.test");
    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().includes("Variables"))
      ?.trigger("click");
    const workspaceVariable = wrapper.get(
      'input[aria-label="Variable name 1"]',
    );
    expect(workspaceVariable.attributes("placeholder")).toBe("Add variable");
    await workspaceVariable.setValue("team");
    await wrapper
      .get('input[aria-label="Variable value 1"]')
      .setValue("platform");
    await wrapper.get('button[type="submit"]').trigger("submit");

    expect(wrapper.emitted("save")).toEqual([
      [
        "Platform",
        "https://api.example.test",
        [{ name: "X-Workspace", value: "platform", enabled: true }],
        [{ name: "team", kind: "value", value: "platform" }],
      ],
    ]);
    wrapper.unmount();
  });

  it("offers workspace deletion only to owners and confirms its revision", async () => {
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
          baseUrl: "",
          headers: [],
          revision: 4,
        },
        variableProfile: {
          workspaceId,
          scopeKind: "workspace",
          scopeId: workspaceId,
          scopeName: "Platform",
          revision: 0,
          variables: [],
        },
        variablePreviews: [],
        canEdit: true,
        canDelete: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    await wrapper
      .get('button[aria-label="More actions for Platform"]')
      .trigger("click");
    await flushPromises();
    await wrapper.get('[role="menuitem"]').trigger("click");
    await flushPromises();
    const confirmation = wrapper.get(".workspace-delete-dialog");
    expect(confirmation.attributes()).toHaveProperty("open");
    expect(confirmation.text()).toContain(
      "collections, requests, environments, and variables",
    );
    await confirmation.get(".danger-button").trigger("click");
    expect(wrapper.emitted("delete")).toEqual([[workspaceId, 4]]);

    await wrapper.setProps({ canDelete: false });
    expect(
      wrapper.find('button[aria-label="More actions for Platform"]').exists(),
    ).toBe(false);
    wrapper.unmount();
  });
});
