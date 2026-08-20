// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import CloseTabsDialog from "../src/view/presentation/features/CloseTabsDialog.vue";

let showModalDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  showModalDescriptor = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    "showModal",
  );
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    /** Simulates the native modal opening in jsdom. */
    value(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
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
  document.body.replaceChildren();
});

/** Creates localization for aggregate close-dialog tests. */
function i18n() {
  return createI18n({
    legacy: false,
    locale: "en-US",
    messages: { "en-US": enUsMessages },
  });
}

describe("CloseTabsDialog", () => {
  it("summarizes dirty and running tabs before confirming once", async () => {
    const wrapper = mount(CloseTabsDialog, {
      attachTo: document.body,
      props: {
        tabCount: 3,
        dirtyTabNames: ["Temporary request", "Workspace"],
        runningCount: 1,
      },
      global: { plugins: [i18n()] },
    });

    expect(wrapper.get("h2").text()).toBe("Close tabs?");
    expect(wrapper.text()).toContain("3 tabs will be closed.");
    expect(wrapper.text()).toContain(
      "2 tabs have unsaved changes that will be discarded:",
    );
    expect(wrapper.get(".close-tabs-dirty-list").text()).toContain(
      "Temporary request",
    );
    expect(wrapper.get(".close-tabs-running-warning").text()).toContain(
      "Closing its tab will not cancel it.",
    );

    await wrapper.get(".danger-button").trigger("click");
    expect(wrapper.emitted("confirm")).toEqual([[]]);
    wrapper.unmount();
  });
});
