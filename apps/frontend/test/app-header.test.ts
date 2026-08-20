// @vitest-environment jsdom

import { ref } from "vue";
import { createI18n } from "vue-i18n";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import { translationServiceKey } from "../src/app/i18n/translation-service";
import type {
  LocaleOption,
  LocalePreference,
  TranslationService,
} from "../src/app/i18n/translation-types";
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
  document.documentElement.removeAttribute("data-theme");
});

describe("AppHeader", () => {
  it("uses the username menu for options and confirmed logout", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const translation = {
      i18n,
      locale: ref("en-US"),
      preference: ref<LocalePreference>("system"),
      locales: ref<readonly LocaleOption[]>([
        {
          locale: "en-US",
          name: "English (United States)",
          direction: "ltr",
        },
      ]),
      setPreference: vi.fn(() => Promise.resolve()),
    } satisfies TranslationService;
    const wrapper = mount(AppHeader, {
      attachTo: document.body,
      props: { username: "admin", navigatorOpen: false },
      global: {
        plugins: [i18n],
        provide: {
          [translationServiceKey as symbol]: translation,
        },
      },
    });

    const accountTrigger = wrapper.get(
      'button[aria-label="Account menu for admin"]',
    );
    expect(wrapper.get<HTMLImageElement>(".brand-logo").attributes("src")).toBe(
      "/logo_square_360.png",
    );
    expect(wrapper.get(".header-actions").text()).toBe("admin");
    expect(accountTrigger.find(".lucide-circle-user-round").exists()).toBe(
      true,
    );

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
      ["Language", "Display style", "Headers that append by default"],
    );
    expect(
      optionsDialog
        .get('button[aria-label="Language"]')
        .element.closest(".select-menu")
        ?.getAttribute("data-density"),
    ).toBe("default");
    const displayStyle = optionsDialog.get(
      'button[aria-label="Display style"]',
    );
    expect(displayStyle.text()).toContain("System");
    expect(displayStyle.find(".lucide-monitor").exists()).toBe(true);
    await displayStyle.trigger("click");
    await flushPromises();
    const lightOption = optionsDialog
      .findAll('[role="option"]')
      .find((option) => option.text().includes("Light"));
    await lightOption?.trigger("click");
    expect(displayStyle.find(".lucide-sun").exists()).toBe(true);
    await displayStyle.trigger("click");
    await flushPromises();
    const darkOption = optionsDialog
      .findAll('[role="option"]')
      .find((option) => option.text().includes("Dark"));
    await darkOption?.trigger("click");
    expect(displayStyle.find(".lucide-moon").exists()).toBe(true);
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
    expect(window.localStorage.getItem("apinteract.displayStyle")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
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
