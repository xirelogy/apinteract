// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import VariableFieldsEditor from "../src/view/presentation/features/VariableFieldsEditor.vue";

describe("VariableFieldsEditor", () => {
  it("restores an unsaved request-variable draft over persisted metadata", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const variableId = "019facab-1eee-765f-bd9f-ac2449151be1";
    const wrapper = mount(VariableFieldsEditor, {
      props: {
        profileVariables: [
          {
            variableId,
            name: "token",
            description: "Authentication token",
            kind: "secret",
            hasValue: true,
            secretVersion: 2,
          },
        ],
        draftVariables: [
          {
            variableId,
            name: "token",
            description: "Authentication token",
            kind: "secret",
            value: "replacement",
          },
        ],
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    expect(
      wrapper.get<HTMLInputElement>('input[aria-label="Secret value 1"]')
        .element.value,
    ).toBe("replacement");
    expect(
      wrapper.get('.secret-input-shell[data-secret-state="replacement"]')
        .element,
    ).toBeInstanceOf(HTMLElement);
    await wrapper
      .get('button[aria-label="Add or edit field description"]')
      .trigger("click");
    expect(
      wrapper.get<HTMLInputElement>('input[aria-label="Field description"]')
        .element.value,
    ).toBe("Authentication token");
    expect(wrapper.vm.writes()).toEqual([
      {
        variableId,
        name: "token",
        description: "Authentication token",
        kind: "secret",
        value: "replacement",
      },
    ]);
  });

  it("shows inherited variables and strikes them when a local declaration overrides them", async () => {
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
            name: "base_url",
            description: "",
            kind: "value",
            value: "https://request.test",
          },
        ],
        inheritedVariables: [
          {
            variable: {
              variableId: "019facab-1eee-765f-bd9f-ac2449151be2",
              name: "base_url",
              description: "",
              kind: "value",
              value: "https://workspace.test",
            },
            source: {
              scope: "workspace",
              scopeId: "019facab-1eee-765f-bd9f-ac2449151be0",
              scopeName: "Shared workspace",
              revision: 2,
            },
          },
          {
            variable: {
              variableId: "019facab-1eee-765f-bd9f-ac2449151be3",
              name: "token",
              description: "",
              kind: "secret",
              hasValue: true,
              secretVersion: 4,
            },
            source: {
              scope: "environment",
              scopeId: "019facab-1eee-765f-bd9f-ac2449151be4",
              scopeName: "Development",
              revision: 4,
            },
          },
        ],
        canEdit: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    const inheritedRows = wrapper.findAll(".inherited-variable-row");
    expect(inheritedRows).toHaveLength(2);
    expect(inheritedRows[0]?.classes()).toContain("is-variable-overridden");
    expect(inheritedRows[1]?.classes()).not.toContain("is-variable-overridden");
    expect(
      inheritedRows[0]
        ?.get('.inherited-variable-indicator[role="img"]')
        .attributes("aria-label"),
    ).toBe("Inherited from Workspace: Shared workspace; overridden here");
    const inheritedSecret = inheritedRows[1]?.get(
      'input[aria-label="Inherited variable value 2"]',
    );
    expect(inheritedSecret?.attributes("placeholder")).toBe(
      "Secret stored — type to replace",
    );
    expect(inheritedSecret?.attributes("readonly")).toBeDefined();
    expect(wrapper.vm.writes()).toEqual([
      {
        variableId: "019facab-1eee-765f-bd9f-ac2449151be1",
        name: "base_url",
        kind: "value",
        value: "https://request.test",
      },
    ]);

    await wrapper.get('input[aria-label="Variable name 2"]').setValue("token");
    expect(wrapper.findAll(".is-variable-overridden")).toHaveLength(2);
    wrapper.unmount();
  });

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
            description: "",
            kind: "value",
            value: "one",
          },
          {
            variableId: "019facab-1eee-765f-bd9f-ac2449151be2",
            name: "second",
            description: "",
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
