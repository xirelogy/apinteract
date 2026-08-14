// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import AppHeader from "../src/view/presentation/layout/AppHeader.vue";

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
  window.localStorage.clear();
});

describe("AppHeader", () => {
  it("uses the username menu for options and confirmed logout", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(AppHeader, {
      attachTo: document.body,
      props: { username: "admin", navigatorOpen: false },
      global: {
        plugins: [i18n],
        stubs: {
          LocaleSelector: {
            template: '<button type="button">English (United States)</button>',
          },
        },
      },
    });

    const accountTrigger = wrapper.get(
      'button[aria-label="Account menu for admin"]',
    );
    expect(wrapper.get(".header-actions").text()).toBe("admin");

    await accountTrigger.trigger("click");
    await flushPromises();
    let menuItems = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    expect(menuItems.map((item) => item.textContent?.trim())).toEqual([
      "Options",
      "Log out",
    ]);

    menuItems[0]?.click();
    await flushPromises();
    const optionsDialog = wrapper.get(".account-options-dialog");
    expect(optionsDialog.attributes()).toHaveProperty("open");
    expect(optionsDialog.get("h2").text()).toBe("Options");
    const optionTabs = optionsDialog.findAll('[role="tab"]');
    expect(optionTabs.map((tab) => tab.text())).toEqual([
      "General",
      "Defaults",
    ]);
    expect(optionTabs[0]?.attributes("aria-selected")).toBe("true");
    expect(optionsDialog.findAll("label").map((label) => label.text())).toEqual(
      ["Language", "Headers that append by default"],
    );
    await optionTabs[1]?.trigger("click");
    expect(optionTabs[1]?.attributes("aria-selected")).toBe("true");
    const appendingHeaders = optionsDialog.get("textarea");
    expect(appendingHeaders.element).toHaveProperty("value", "Cookie");
    await appendingHeaders.setValue("Cookie\nX-List");

    await optionsDialog.get(".primary-button").trigger("click");
    expect(optionsDialog.attributes()).not.toHaveProperty("open");
    expect(
      JSON.parse(
        window.localStorage.getItem("apinteract.appendingHeaders") ?? "[]",
      ),
    ).toEqual(["Cookie", "X-List"]);
    await accountTrigger.trigger("click");
    await flushPromises();
    menuItems = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    menuItems[1]?.click();
    await flushPromises();

    const logoutDialog = wrapper.get(".logout-confirmation-dialog");
    expect(logoutDialog.attributes()).toHaveProperty("open");
    expect(logoutDialog.text()).toContain("Are you sure you want to log out?");
    expect(wrapper.emitted("logout")).toBeUndefined();

    await logoutDialog.get(".danger-button").trigger("click");
    expect(wrapper.emitted("logout")).toEqual([[]]);
  });
});
