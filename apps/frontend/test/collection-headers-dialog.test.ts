// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import CollectionHeadersDialog from "../src/view/presentation/features/CollectionHeadersDialog.vue";

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

describe("CollectionHeadersDialog", () => {
  it("edits ordered enabled state and emits meaningful common headers", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(CollectionHeadersDialog, {
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
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    await wrapper.get("button.add-field-button").trigger("click");
    await wrapper.get('input[aria-label="Header name 1"]').setValue("X-Team");
    await wrapper
      .get('input[aria-label="Header value 1"]')
      .setValue("platform");
    await wrapper.get('button[type="submit"]').trigger("click");

    expect(wrapper.emitted("save")).toEqual([
      [[{ name: "X-Team", value: "platform", enabled: true }]],
    ]);
    wrapper.unmount();
  });
});
