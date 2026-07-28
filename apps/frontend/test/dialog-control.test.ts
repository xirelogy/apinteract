// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import DialogControl from "@/view/presentation/controls/dialog/DialogControl.vue";

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
    /** Simulates native top-layer opening for the jsdom contract test. */
    value(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    /** Simulates native closure and its lifecycle event for jsdom. */
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

describe("DialogControl", () => {
  it("opens natively and reports backdrop closure through controlled state", async () => {
    const wrapper = mount(DialogControl, {
      attachTo: document.body,
      props: { open: true },
      slots: { default: "Dialog content" },
    });

    const dialog = wrapper.get("dialog");
    expect(dialog.attributes("open")).toBe("");
    await dialog.trigger("click");
    expect(wrapper.emitted("update:open")).toEqual([[false]]);
    expect(wrapper.emitted("close")).toHaveLength(1);

    wrapper.unmount();
  });

  it("prevents Escape dismissal while busy", () => {
    const wrapper = mount(DialogControl, {
      attachTo: document.body,
      props: { open: true, busy: true },
    });
    const event = new Event("cancel", { bubbles: true, cancelable: true });
    wrapper.get("dialog").element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    wrapper.unmount();
  });
});
