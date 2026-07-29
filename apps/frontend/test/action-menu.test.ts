// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

import ActionMenu from "@/view/presentation/controls/ActionMenu.vue";

afterEach(() => document.body.replaceChildren());

describe("ActionMenu", () => {
  it("opens beside its trigger, navigates actions, and restores focus", async () => {
    const wrapper = mount(ActionMenu, {
      attachTo: document.body,
      props: {
        label: "More actions for Examples",
        items: [
          { value: "request", label: "Create request" },
          { value: "headers", label: "Edit headers" },
        ],
      },
    });
    const trigger = wrapper.get<HTMLButtonElement>("button");

    await trigger.trigger("keydown", { key: "ArrowDown" });
    await flushPromises();
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    const items = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    expect(menu?.getAttribute("aria-label")).toBe("More actions for Examples");
    expect(document.activeElement).toBe(items[0]);

    items[0]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await flushPromises();
    expect(document.activeElement).toBe(items[1]);
    items[1]?.click();
    await flushPromises();
    expect(wrapper.emitted("select")).toEqual([["headers"]]);
    expect(document.activeElement).toBe(trigger.element);

    wrapper.unmount();
  });
});
