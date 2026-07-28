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
    expect(wrapper.emitted("update:open")).toEqual([[true]]);

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

  it("supports buffered typeahead and skips disabled options", async () => {
    const wrapper = mount(SelectMenu, {
      attachTo: document.body,
      props: {
        modelValue: "apple",
        label: "Fruit",
        options: [
          { value: "apple", label: "Apple" },
          { value: "banana", label: "Banana", disabled: true },
          { value: "blueberry", label: "Blueberry" },
          { value: "blackberry", label: "Blackberry" },
        ],
      },
      global: {
        plugins: [i18n],
      },
    });

    await wrapper.get(".select-menu-trigger").trigger("click");
    await flushPromises();
    const options = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ];
    options[0]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", bubbles: true }),
    );
    await flushPromises();
    expect(document.activeElement).toBe(options[2]);
    options[2]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "l", bubbles: true }),
    );
    await flushPromises();
    expect(document.activeElement).toBe(options[2]);

    options[2]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await flushPromises();
    expect(document.activeElement).toBe(options[3]);

    wrapper.unmount();
  });

  it("opens a matching option from closed-trigger typeahead", async () => {
    const wrapper = mount(SelectMenu, {
      attachTo: document.body,
      props: {
        modelValue: "apple",
        label: "Fruit",
        options: [
          { value: "apple", label: "Apple" },
          { value: "banana", label: "Banana" },
        ],
      },
      global: {
        plugins: [i18n],
      },
    });

    const trigger = wrapper.get('[role="combobox"]');
    await trigger.trigger("keydown", { key: "b" });
    await flushPromises();

    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(document.activeElement?.textContent).toContain("Banana");
    wrapper.unmount();
  });
});
