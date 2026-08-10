// @vitest-environment jsdom

import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { useRowReorder } from "../src/view/presentation/controls/row-reorder";

const RowReorderHost = defineComponent({
  /** Exposes a minimal meaningful-row list followed by one blank row. */
  setup() {
    const rows = ref(["A", "B", "C", ""]);
    const reorder = useRowReorder({
      canMove: (index) =>
        rows.value[index] !== undefined && rows.value[index] !== "",
      move(fromIndex, toIndex) {
        const [row] = rows.value.splice(fromIndex, 1);
        if (row !== undefined) rows.value.splice(toIndex, 0, row);
      },
      isDisabled: () => false,
    });
    return { rows, reorder };
  },
  template: `
    <div>
      <div
        v-for="(row, index) in rows"
        :key="row || 'blank'"
        class="test-row"
        :class="reorder.classes(index)"
        @dragover="reorder.updateDropTarget($event, index)"
        @drop="reorder.finishDrop($event)"
      >
        <button
          v-if="row"
          class="test-handle"
          draggable="true"
          @dragstart="reorder.startDrag($event, index)"
        >{{ row }}</button>
      </div>
    </div>
  `,
});

/** Applies stable row bounds required by midpoint-based jsdom drag events. */
function setRowBounds(wrapper: VueWrapper): void {
  for (const row of wrapper.findAll<HTMLElement>(".test-row")) {
    vi.spyOn(row.element, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 200,
      bottom: 40,
      left: 0,
      width: 200,
      height: 40,
      toJSON: () => ({}),
    });
  }
}

/** Creates the mutable transfer fields used by native drag handlers. */
function dataTransfer() {
  return {
    dropEffect: "none",
    effectAllowed: "uninitialized",
    setData: vi.fn(),
  };
}

describe("row reorder boundaries", () => {
  it("normalizes after-above and before-below to one insertion line", async () => {
    const wrapper = mount(RowReorderHost);
    setRowBounds(wrapper);
    const transfer = dataTransfer();
    const handles = wrapper.findAll(".test-handle");
    const rows = wrapper.findAll(".test-row");

    await handles[0]?.trigger("dragstart", { dataTransfer: transfer });
    await rows[1]?.trigger("dragover", {
      clientY: 30,
      dataTransfer: transfer,
    });
    expect(wrapper.findAll(".is-row-drop-before")).toHaveLength(1);
    expect(rows[2]?.classes()).toContain("is-row-drop-before");

    await rows[2]?.trigger("dragover", {
      clientY: 10,
      dataTransfer: transfer,
    });
    expect(wrapper.findAll(".is-row-drop-before")).toHaveLength(1);
    expect(rows[2]?.classes()).toContain("is-row-drop-before");
    await rows[0]?.trigger("drop", {
      clientY: 30,
      dataTransfer: transfer,
    });

    expect(wrapper.vm.rows).toEqual(["B", "A", "C", ""]);
    wrapper.unmount();
  });

  it("accepts the final boundary represented by the trailing blank row", async () => {
    const wrapper = mount(RowReorderHost);
    setRowBounds(wrapper);
    const transfer = dataTransfer();
    const handles = wrapper.findAll(".test-handle");
    const rows = wrapper.findAll(".test-row");

    await handles[0]?.trigger("dragstart", { dataTransfer: transfer });
    await rows[3]?.trigger("dragover", {
      clientY: 10,
      dataTransfer: transfer,
    });
    expect(rows[3]?.classes()).toContain("is-row-drop-before");
    await rows[3]?.trigger("drop", {
      clientY: 10,
      dataTransfer: transfer,
    });

    expect(wrapper.vm.rows).toEqual(["B", "C", "A", ""]);
    wrapper.unmount();
  });
});
