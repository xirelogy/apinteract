// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import EnvironmentManager from "../src/view/presentation/features/EnvironmentManager.vue";

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

describe("EnvironmentManager", () => {
  it("orders creation and inactive edits in the environment action menu", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const developmentId = "019fa8be-a510-76b9-b73b-69f4c7af7875";
    const stagingId = "019fa8be-a510-76b9-b73b-69f4c7af7876";
    const wrapper = mount(EnvironmentManager, {
      attachTo: document.body,
      props: {
        environments: [
          { environmentId: developmentId, name: "Development", revision: 1 },
          { environmentId: stagingId, name: "Staging", revision: 1 },
        ],
        selectedEnvironmentId: developmentId,
        environment: null,
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    await wrapper
      .get('button[aria-label="Manage environments"]')
      .trigger("click");
    await flushPromises();
    let menuItems = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    expect(menuItems.map((item) => item.textContent)).toEqual([
      "Edit Development",
      "Create new environment",
      "Edit Staging",
    ]);

    menuItems[1]?.click();
    await flushPromises();
    expect(wrapper.get("dialog").attributes()).toHaveProperty("open");
    expect(wrapper.get("h2").text()).toBe("Create environment");
    expect(wrapper.emitted("load")).toBeUndefined();

    await wrapper.get('button[aria-label="Close"]').trigger("click");
    expect(wrapper.get("dialog").attributes()).not.toHaveProperty("open");

    await wrapper
      .get('button[aria-label="Manage environments"]')
      .trigger("click");
    await flushPromises();
    menuItems = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    menuItems[2]?.click();
    await flushPromises();
    expect(wrapper.emitted("load")).toEqual([[stagingId]]);
    expect(wrapper.emitted("select")).toBeUndefined();

    await wrapper.get('button[aria-label="Close"]').trigger("click");
    await wrapper.setProps({ selectedEnvironmentId: null });
    await wrapper
      .get('button[aria-label="Manage environments"]')
      .trigger("click");
    await flushPromises();
    menuItems = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    expect(menuItems.map((item) => item.textContent)).toEqual([
      "Create new environment",
      "Edit Development",
      "Edit Staging",
    ]);
    wrapper.unmount();
  });

  it("keeps the editor open until persistence and refresh are confirmed", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(EnvironmentManager, {
      attachTo: document.body,
      props: {
        environments: [],
        selectedEnvironmentId: null,
        environment: null,
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    await wrapper
      .get('button[aria-label="Manage environments"]')
      .trigger("click");
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.click();
    await flushPromises();
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("create")).toEqual([["", []]]);
    expect(wrapper.get("dialog").attributes()).toHaveProperty("open");

    await wrapper.setProps({ busy: true });
    const cancelButton = wrapper
      .findAll("button")
      .find((button) => button.text() === "Cancel");
    expect(cancelButton?.attributes()).toHaveProperty("disabled");

    wrapper.vm.finishMutation();
    await wrapper.vm.$nextTick();
    expect(wrapper.get("dialog").attributes()).not.toHaveProperty("open");
    wrapper.unmount();
  });

  it("moves deletion into the editor menu and confirms it in a styled dialog", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const environmentId = "019fa8be-a510-76b9-b73b-69f4c7af7875";
    const wrapper = mount(EnvironmentManager, {
      attachTo: document.body,
      props: {
        environments: [{ environmentId, name: "Development", revision: 2 }],
        selectedEnvironmentId: environmentId,
        environment: {
          environmentId,
          workspaceId: "019fa8be-a510-76b9-b73b-69f4c7af7876",
          name: "Development",
          revision: 2,
          variables: [],
          inheritedVariables: [],
        },
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    await wrapper
      .get('button[aria-label="Manage environments"]')
      .trigger("click");
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.click();
    await flushPromises();

    const editor = wrapper.get(".environment-dialog");
    expect(editor.attributes()).toHaveProperty("open");
    expect(
      editor.findAll("footer button").map((button) => button.text()),
    ).toEqual(["Cancel", "Save"]);

    await wrapper
      .get('button[aria-label="More actions for Development"]')
      .trigger("click");
    await flushPromises();
    const deleteMenuItem = editor.get('[role="menuitem"]');
    expect(deleteMenuItem.text()).toBe("Delete environment");
    expect(deleteMenuItem.attributes("data-variant")).toBe("danger");
    await deleteMenuItem.trigger("click");
    await flushPromises();

    const confirmation = wrapper.get(".environment-delete-dialog");
    expect(confirmation.attributes()).toHaveProperty("open");
    expect(confirmation.get("h2").text()).toBe("Delete environment?");
    expect(confirmation.text()).toContain(
      "“Development” and all of its variables will be permanently deleted.",
    );
    expect(wrapper.emitted("delete")).toBeUndefined();

    await confirmation.get(".danger-button").trigger("click");
    expect(wrapper.emitted("delete")).toEqual([[environmentId, 2]]);
    expect(confirmation.attributes()).toHaveProperty("open");

    await wrapper.setProps({ busy: true });
    expect(confirmation.get(".danger-button").attributes()).toHaveProperty(
      "disabled",
    );
    wrapper.vm.finishMutation();
    await wrapper.vm.$nextTick();
    expect(editor.attributes()).not.toHaveProperty("open");
    expect(wrapper.find(".environment-delete-dialog").exists()).toBe(false);
    wrapper.unmount();
  });

  it("preserves a stored secret without rendering or resubmitting plaintext", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const environmentId = "019fa8be-a510-76b9-b73b-69f4c7af7875";
    const wrapper = mount(EnvironmentManager, {
      attachTo: document.body,
      props: {
        environments: [{ environmentId, name: "Development", revision: 2 }],
        selectedEnvironmentId: environmentId,
        environment: null,
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    await wrapper
      .get('button[aria-label="Manage environments"]')
      .trigger("click");
    await flushPromises();
    document.body
      .querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.click();
    await flushPromises();
    expect(wrapper.emitted("load")).toEqual([[environmentId]]);
    await wrapper.setProps({
      environment: {
        environmentId,
        workspaceId: "019fa8be-a510-76b9-b73b-69f4c7af7876",
        name: "Development",
        revision: 2,
        variables: [
          {
            variableId: "019fa8be-a510-76b9-b73b-69f4c7af7877",
            name: "token",
            kind: "secret",
            hasValue: true,
            secretVersion: 4,
          },
        ],
        inheritedVariables: [],
      },
    });

    const secretInput = wrapper.get('input[aria-label="Secret value 1"]');
    expect((secretInput.element as HTMLInputElement).value).toBe("");
    expect(
      wrapper
        .get('button[aria-label="Variable kind 1"]')
        .attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.get(".variable-type-cell[title]").attributes("title")).toBe(
      "Variable type cannot be changed after saving to prevent secret disclosure.",
    );
    expect(wrapper.get(".variable-field-heading").text()).toContain(
      "NameTypeValue / Target",
    );
    expect(
      wrapper
        .get('input[aria-label="Variable name 2"]')
        .attributes("placeholder"),
    ).toBe("Add variable");
    expect(wrapper.text()).not.toContain("top-secret-token");
    await wrapper.get('button[type="submit"]').trigger("submit");
    expect(wrapper.emitted("save")?.[0]).toEqual([
      environmentId,
      2,
      "Development",
      [
        {
          variableId: "019fa8be-a510-76b9-b73b-69f4c7af7877",
          name: "token",
          kind: "secret",
        },
      ],
    ]);
    wrapper.unmount();
  });
});
