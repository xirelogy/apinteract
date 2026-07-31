// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
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
  it("preserves redacted secrets and prevents persisted kind changes", async () => {
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
              kind: "secret",
              hasValue: true,
              secretVersion: 4,
            },
          ],
        },
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    expect(
      wrapper.get('button[aria-label="Variable kind 1"]').attributes(),
    ).toHaveProperty("disabled");
    expect(
      (
        wrapper.get('input[aria-label="Secret value 1"]')
          .element as HTMLInputElement
      ).value,
    ).toBe("");
    expect(wrapper.text()).not.toContain("stored-plaintext");
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
    wrapper.unmount();
  });
});
