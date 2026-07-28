// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { h } from "vue";

import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import CheckboxControl from "@/view/presentation/controls/CheckboxControl.vue";
import FormField from "@/view/presentation/controls/FormField.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";

afterEach(() => {
  document.body.replaceChildren();
});

describe("control foundation", () => {
  it("keeps button semantics explicit while busy", () => {
    const wrapper = mount(ButtonControl, {
      props: {
        busy: true,
        variant: "primary",
      },
      slots: {
        default: "Save",
      },
    });

    const button = wrapper.get("button");
    expect(button.attributes("type")).toBe("button");
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("aria-busy")).toBe("true");
    expect(button.attributes("data-busy")).toBe("");
  });

  it("requires icon buttons to expose an accessible name", () => {
    const wrapper = mount(IconButton, {
      props: {
        label: "Close",
      },
      slots: {
        default: "×",
      },
    });

    const button = wrapper.get("button");
    expect(button.attributes("aria-label")).toBe("Close");
    expect(button.attributes("title")).toBe("Close");
  });

  it("preserves native checkbox state and emits boolean updates", async () => {
    const wrapper = mount(CheckboxControl, {
      attachTo: document.body,
      props: {
        modelValue: "indeterminate",
        label: "Enabled",
      },
    });

    const input = wrapper.get<HTMLInputElement>('input[type="checkbox"]');
    expect(input.element.indeterminate).toBe(true);
    expect(wrapper.get("label").attributes("data-state")).toBe("indeterminate");

    input.element.checked = true;
    await input.trigger("change");
    expect(wrapper.emitted("update:modelValue")).toEqual([[true]]);
  });

  it("connects form labels, hints, and errors to the slotted control", () => {
    const wrapper = mount(FormField, {
      props: {
        label: "Target URL",
        hint: "Use an HTTPS URL",
        error: "Target is required",
      },
      slots: {
        default: (slotProps: {
          controlId: string;
          describedBy: string | undefined;
          invalid: boolean;
        }) =>
          h("input", {
            id: slotProps.controlId,
            "aria-describedby": slotProps.describedBy,
            "aria-invalid": String(slotProps.invalid),
          }),
      },
    });

    const label = wrapper.get("label");
    const input = wrapper.get("input");
    expect(label.attributes("for")).toBe(input.attributes("id"));
    expect(input.attributes("aria-describedby")?.split(" ")).toHaveLength(2);
    expect(input.attributes("aria-invalid")).toBe("true");
  });

  it("updates text values through the standard model contract", async () => {
    const wrapper = mount(TextInput, {
      props: {
        modelValue: "before",
      },
    });

    await wrapper.get("input").setValue("after");
    expect(wrapper.emitted("update:modelValue")).toEqual([["after"]]);
  });
});
