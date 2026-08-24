// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import VariableFieldsEditor from "../src/view/presentation/features/VariableFieldsEditor.vue";
import VariableProfileDialog from "../src/view/presentation/features/VariableProfileDialog.vue";

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

describe("VariableProfileDialog", () => {
  it("presents a secret without a stored value as an empty protected field", () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(VariableFieldsEditor, {
      attachTo: document.body,
      props: {
        profileVariables: [
          {
            variableId: "019facab-1eee-765f-bd9f-ac2449151be3",
            name: "optional-token",
            description: "",
            kind: "secret",
            hasValue: false,
            secretVersion: 0,
          },
        ],
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    const shell = wrapper.get('.secret-input-shell[data-secret-state="empty"]');
    const secretInput = shell.get('input[aria-label="Secret value 1"]');
    const descriptionId = secretInput.attributes("aria-describedby");
    expect(secretInput.attributes("placeholder")).toBe("Enter secret value");
    expect(shell.find("button").exists()).toBe(false);
    expect(document.getElementById(descriptionId ?? "")?.textContent).toContain(
      "No secret is stored.",
    );
    wrapper.unmount();
  });

  it("edits stored secrets without exposing their existing value", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(VariableProfileDialog, {
      attachTo: document.body,
      props: {
        profile: {
          workspaceId: "019facab-1eee-765f-bd9f-ac2449151be0",
          scopeKind: "request",
          scopeId: "019facab-1eee-765f-bd9f-ac2449151be1",
          scopeName: "Create customer",
          revision: 3,
          variables: [
            {
              variableId: "019facab-1eee-765f-bd9f-ac2449151be2",
              name: "token",
              description: "",
              kind: "secret",
              hasValue: true,
              secretVersion: 4,
            },
          ],
          inheritedVariables: [],
        },
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    expect(
      wrapper.get('button[aria-label="Variable kind 1"]').attributes(),
    ).toHaveProperty("disabled");
    const secretInput = wrapper.get('input[aria-label="Secret value 1"]');
    expect((secretInput.element as HTMLInputElement).value).toBe("");
    expect(secretInput.attributes("type")).toBe("password");
    expect(secretInput.attributes("placeholder")).toBe(
      "Secret stored — type to replace",
    );
    expect(secretInput.attributes("aria-describedby")).toBeTruthy();
    expect(
      wrapper.get('.secret-input-shell[data-secret-state="stored"]').element,
    ).toBeInstanceOf(HTMLElement);
    expect(wrapper.get(".secret-input-lock").element).toBeInstanceOf(
      SVGElement,
    );
    expect(
      wrapper
        .get('button[aria-label="Clear stored secret"]')
        .element.closest(".secret-input-shell"),
    ).not.toBeNull();
    expect(wrapper.text()).not.toContain("stored-plaintext");
    expect(
      wrapper
        .get('input[aria-label="Variable name 2"]')
        .attributes("placeholder"),
    ).toBe("Add variable");
    expect(
      wrapper.get(".variable-field-row .new-row-marker").element.tagName,
    ).toBe("SPAN");
    await wrapper.get('button[type="submit"]').trigger("submit");
    expect(wrapper.emitted("save")).toEqual([
      [
        [
          {
            variableId: "019facab-1eee-765f-bd9f-ac2449151be2",
            name: "token",
            kind: "secret",
          },
        ],
      ],
    ]);

    await wrapper
      .get('button[aria-label="Clear stored secret"]')
      .trigger("click");
    expect(
      wrapper.get('.secret-input-shell[data-secret-state="pending-clear"]')
        .element,
    ).toBeInstanceOf(HTMLElement);
    expect(secretInput.attributes("placeholder")).toBe(
      "Secret will be cleared on save",
    );
    expect(wrapper.text()).toContain(
      "The stored secret will be cleared when you save.",
    );
    await wrapper.get('button[type="submit"]').trigger("submit");
    expect(wrapper.emitted("save")?.at(-1)).toEqual([
      [
        {
          variableId: "019facab-1eee-765f-bd9f-ac2449151be2",
          name: "token",
          kind: "secret",
          clearValue: true,
        },
      ],
    ]);

    await wrapper
      .get('button[aria-label="Keep stored secret"]')
      .trigger("click");
    expect(
      wrapper.get('.secret-input-shell[data-secret-state="stored"]').element,
    ).toBeInstanceOf(HTMLElement);

    await secretInput.setValue("replacement-secret");
    expect(
      wrapper.get('.secret-input-shell[data-secret-state="replacement"]')
        .element,
    ).toBeInstanceOf(HTMLElement);
    await wrapper.get('button[type="submit"]').trigger("submit");
    expect(wrapper.emitted("save")?.at(-1)).toEqual([
      [
        {
          variableId: "019facab-1eee-765f-bd9f-ac2449151be2",
          name: "token",
          kind: "secret",
          value: "replacement-secret",
        },
      ],
    ]);

    await wrapper
      .get('button[aria-label="Discard replacement"]')
      .trigger("click");
    expect((secretInput.element as HTMLInputElement).value).toBe("");
    expect(
      wrapper.get('.secret-input-shell[data-secret-state="stored"]').element,
    ).toBeInstanceOf(HTMLElement);

    await secretInput.setValue("another-replacement");
    await secretInput.setValue("");
    expect(
      wrapper.get('.secret-input-shell[data-secret-state="stored"]').element,
    ).toBeInstanceOf(HTMLElement);
    await wrapper.get('button[type="submit"]').trigger("submit");
    expect(wrapper.emitted("save")?.at(-1)).toEqual([
      [
        {
          variableId: "019facab-1eee-765f-bd9f-ac2449151be2",
          name: "token",
          kind: "secret",
        },
      ],
    ]);
    wrapper.unmount();
  });
});
