// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import VariableFieldsEditor from "../src/view/presentation/features/VariableFieldsEditor.vue";

describe("VariableFieldsEditor", () => {
  it("reorders persisted variables with the keyboard and keeps the blank row last", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(VariableFieldsEditor, {
      props: {
        profileVariables: [
          {
            variableId: "019facab-1eee-765f-bd9f-ac2449151be1",
            name: "first",
            kind: "value",
            value: "one",
          },
          {
            variableId: "019facab-1eee-765f-bd9f-ac2449151be2",
            name: "second",
            kind: "value",
            value: "two",
          },
        ],
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    expect(wrapper.findAll(".row-reorder-handle")).toHaveLength(2);
    expect(wrapper.findAll(".new-row-marker")).toHaveLength(1);
    await wrapper.get(".row-reorder-handle").trigger("keydown", {
      key: "ArrowDown",
      altKey: true,
    });

    expect(wrapper.vm.writes()).toEqual([
      {
        variableId: "019facab-1eee-765f-bd9f-ac2449151be2",
        name: "second",
        kind: "value",
        value: "two",
      },
      {
        variableId: "019facab-1eee-765f-bd9f-ac2449151be1",
        name: "first",
        kind: "value",
        value: "one",
      },
    ]);
    expect(wrapper.findAll(".new-row-marker")).toHaveLength(1);
    wrapper.unmount();
  });

  it("keeps unsaved input instances aligned with their reordered rows", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(VariableFieldsEditor, {
      props: {
        profileVariables: [],
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    await wrapper.get('input[aria-label="Variable name 1"]').setValue("first");
    await wrapper.get('input[aria-label="Variable value 1"]').setValue("one");
    await wrapper.get('input[aria-label="Variable name 2"]').setValue("second");
    await wrapper.get('input[aria-label="Variable value 2"]').setValue("two");
    await wrapper.get(".row-reorder-handle").trigger("keydown", {
      key: "ArrowDown",
      altKey: true,
    });

    expect(
      wrapper.get<HTMLInputElement>('input[aria-label="Variable name 1"]')
        .element.value,
    ).toBe("second");
    expect(wrapper.vm.writes()).toEqual([
      { name: "second", kind: "value", value: "two" },
      { name: "first", kind: "value", value: "one" },
    ]);

    const rows = wrapper.findAll<HTMLElement>(".variable-field-row");
    const blankRow = rows[2]!;
    vi.spyOn(blankRow.element, "getBoundingClientRect").mockReturnValue({
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
    const transfer = {
      dropEffect: "none",
      effectAllowed: "uninitialized",
      setData: vi.fn(),
    };
    await wrapper
      .get(".row-reorder-handle")
      .trigger("dragstart", { dataTransfer: transfer });
    await blankRow.trigger("dragover", { clientY: 10, dataTransfer: transfer });
    expect(blankRow.classes()).toContain("is-row-drop-before");
    await blankRow.trigger("drop", { clientY: 10, dataTransfer: transfer });
    expect(wrapper.vm.writes()).toEqual([
      { name: "first", kind: "value", value: "one" },
      { name: "second", kind: "value", value: "two" },
    ]);

    const refreshedRows = wrapper.findAll<HTMLElement>(".variable-field-row");
    const refreshedBlankRow = refreshedRows[2]!;
    vi.spyOn(
      refreshedBlankRow.element,
      "getBoundingClientRect",
    ).mockReturnValue({
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
    await wrapper
      .get(".row-reorder-handle")
      .trigger("dragstart", { dataTransfer: transfer });
    await refreshedBlankRow.trigger("dragover", {
      clientY: 10,
      dataTransfer: transfer,
    });
    await refreshedBlankRow.trigger("drop", {
      clientY: 10,
      dataTransfer: transfer,
    });
    expect(wrapper.vm.writes()).toEqual([
      { name: "second", kind: "value", value: "two" },
      { name: "first", kind: "value", value: "one" },
    ]);
    wrapper.unmount();
  });
});
