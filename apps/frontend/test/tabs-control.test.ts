// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";

import TabsList from "@/view/presentation/controls/tabs/TabsList.vue";
import TabsPanel from "@/view/presentation/controls/tabs/TabsPanel.vue";
import TabsRoot from "@/view/presentation/controls/tabs/TabsRoot.vue";
import TabsTrigger from "@/view/presentation/controls/tabs/TabsTrigger.vue";

const TabsTestHost = defineComponent({
  components: { TabsList, TabsPanel, TabsRoot, TabsTrigger },
  /** Supplies controlled tab state to the test-only composite host. */
  setup() {
    return { selected: ref("one") };
  },
  template: `
    <TabsRoot v-model="selected">
      <TabsList label="Example tabs">
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
        <TabsTrigger value="three">Three</TabsTrigger>
      </TabsList>
      <TabsPanel value="one">First</TabsPanel>
      <TabsPanel value="two">Second</TabsPanel>
      <TabsPanel value="three">Third</TabsPanel>
    </TabsRoot>
  `,
});

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.dir = "";
});

describe("TabsControl", () => {
  it("links tabs and panels and activates the next tab from the keyboard", async () => {
    const wrapper = mount(TabsTestHost, { attachTo: document.body });

    const triggers = wrapper.findAll<HTMLButtonElement>('[role="tab"]');
    const panels = wrapper.findAll<HTMLElement>('[role="tabpanel"]');
    expect(triggers[0]?.attributes("aria-controls")).toBe(
      panels[0]?.attributes("id"),
    );
    expect(panels[0]?.attributes("aria-labelledby")).toBe(
      triggers[0]?.attributes("id"),
    );

    triggers[0]?.element.focus();
    await triggers[0]?.trigger("keydown", { key: "ArrowRight" });
    await flushPromises();

    expect(document.activeElement).toBe(triggers[1]?.element);
    expect(triggers[1]?.attributes("aria-selected")).toBe("true");
    expect(panels[1]?.attributes("hidden")).toBeUndefined();

    wrapper.unmount();
  });

  it("reverses horizontal arrow direction for RTL", async () => {
    document.documentElement.dir = "rtl";
    const wrapper = mount(TabsTestHost, { attachTo: document.body });

    const triggers = wrapper.findAll<HTMLButtonElement>('[role="tab"]');
    triggers[0]?.element.focus();
    await triggers[0]?.trigger("keydown", { key: "ArrowRight" });
    await flushPromises();
    expect(document.activeElement).toBe(triggers[2]?.element);

    wrapper.unmount();
  });
});
