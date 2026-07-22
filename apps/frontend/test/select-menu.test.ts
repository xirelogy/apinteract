// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";

import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      common: {
        actions: {
          close: "Close",
        },
      },
    },
  },
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("SelectMenu", () => {
  it("supports keyboard navigation and emits the selected value", async () => {
    const wrapper = mount(SelectMenu, {
      attachTo: document.body,
      props: {
        modelValue: "first",
        label: "Example",
        options: [
          { value: "first", label: "First" },
          { value: "second", label: "Second" },
        ],
      },
      global: {
        plugins: [i18n],
      },
    });

    await wrapper
      .get(".select-menu-trigger")
      .trigger("keydown", { key: "ArrowDown" });
    await flushPromises();

    const options = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ];
    expect(document.activeElement).toBe(options[0]);

    options[0]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await flushPromises();
    expect(document.activeElement).toBe(options[1]);

    options[1]?.click();
    await flushPromises();
    expect(wrapper.emitted("update:modelValue")).toEqual([["second"]]);
    expect(document.body.querySelector(".select-menu-popup")).toBeNull();

    wrapper.unmount();
  });
});
