// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";

import { useTreeNavigation } from "@/view/presentation/controls/tree/useTreeNavigation";

const TreeNavigationHost = defineComponent({
  /** Supplies expansion state and shared keyboard handlers to a test tree. */
  setup() {
    const expanded = ref(false);
    const navigation = useTreeNavigation();
    return { expanded, navigation };
  },
  template: `
    <ul
      role="tree"
      @focusin="navigation.handleFocusIn"
      @keydown="navigation.handleKeydown"
    >
      <li>
        <div class="workspace-tree-row">
          <button
            class="tree-toggle-button"
            type="button"
            tabindex="-1"
            @click="expanded = !expanded"
          >Toggle</button>
          <button
            type="button"
            role="treeitem"
            aria-level="1"
            :aria-expanded="expanded"
            data-tree-node-id="parent"
            data-tree-text="Alpha"
            tabindex="0"
          >Alpha</button>
        </div>
        <ul v-if="expanded" role="group">
          <li>
            <button
              type="button"
              role="treeitem"
              aria-level="2"
              data-tree-node-id="child"
              data-tree-parent-id="parent"
              data-tree-text="Beta"
              tabindex="-1"
            >Beta</button>
          </li>
        </ul>
      </li>
      <li>
        <button
          type="button"
          role="treeitem"
          aria-level="1"
          data-tree-node-id="sibling"
          data-tree-text="Gamma"
          tabindex="-1"
        >Gamma</button>
      </li>
    </ul>
  `,
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("tree navigation", () => {
  it("expands, enters children, navigates, and returns to parents", async () => {
    const wrapper = mount(TreeNavigationHost, { attachTo: document.body });
    const parent = wrapper.get<HTMLButtonElement>(
      '[data-tree-node-id="parent"]',
    );
    parent.element.focus();

    await parent.trigger("keydown", { key: "ArrowRight" });
    await flushPromises();
    expect(parent.attributes("aria-expanded")).toBe("true");

    await parent.trigger("keydown", { key: "ArrowRight" });
    await flushPromises();
    const child = wrapper.get<HTMLButtonElement>('[data-tree-node-id="child"]');
    expect(document.activeElement).toBe(child.element);

    await child.trigger("keydown", { key: "ArrowDown" });
    const sibling = wrapper.get<HTMLButtonElement>(
      '[data-tree-node-id="sibling"]',
    );
    expect(document.activeElement).toBe(sibling.element);

    child.element.focus();
    await child.trigger("keydown", { key: "ArrowLeft" });
    expect(document.activeElement).toBe(parent.element);

    wrapper.unmount();
  });

  it("supports typeahead across rendered tree items", async () => {
    const wrapper = mount(TreeNavigationHost, { attachTo: document.body });
    const parent = wrapper.get<HTMLButtonElement>(
      '[data-tree-node-id="parent"]',
    );
    parent.element.focus();
    await parent.trigger("keydown", { key: "g" });
    expect(document.activeElement).toBe(
      wrapper.get('[data-tree-node-id="sibling"]').element,
    );
    wrapper.unmount();
  });
});
