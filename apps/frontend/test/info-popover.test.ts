// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

import InfoPopover from "@/view/presentation/controls/InfoPopover.vue";

afterEach(() => document.body.replaceChildren());

describe("InfoPopover", () => {
  it("reveals accessible information and dismisses it with Escape or outside input", async () => {
    const wrapper = mount(InfoPopover, {
      attachTo: document.body,
      props: { label: "More information about inheritance" },
      slots: { default: "Later values override earlier values." },
    });
    const trigger = wrapper.get<HTMLButtonElement>("button");

    await trigger.trigger("click");
    await flushPromises();
    let note = document.body.querySelector<HTMLElement>('[role="note"]');
    expect(note?.textContent).toBe("Later values override earlier values.");
    expect(note?.classList).toContain("is-positioned");
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(trigger.attributes("aria-controls")).toBe(note?.id);
    expect(trigger.attributes("aria-describedby")).toBe(note?.id);

    trigger.element.focus();
    await trigger.trigger("keydown", { key: "Escape" });
    expect(document.body.querySelector('[role="note"]')).toBeNull();

    await trigger.trigger("click");
    await flushPromises();
    note = document.body.querySelector<HTMLElement>('[role="note"]');
    expect(note).not.toBeNull();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(document.body.querySelector('[role="note"]')).toBeNull();

    wrapper.unmount();
  });
});
