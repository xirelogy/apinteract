// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import RequestEditor from "../src/view/presentation/features/RequestEditor.vue";

describe("RequestEditor", () => {
  it("allows a target URL containing an environment placeholder", async () => {
    vi.useFakeTimers();
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(RequestEditor, {
      props: {
        request: null,
        draft: {
          name: "Templated request",
          method: "GET",
          targetUrl: "<<base_url>>/resource",
          query: [],
          headers: [],
          body: "",
        },
        execution: null,
        tabId: "019facab-1eee-765f-bd9f-ac2449151be0",
        temporary: true,
        inheritedHeaders: [],
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    const buttons = wrapper.findAll(".command-bar button");
    const save = buttons.find((button) => button.text().includes("Save"));
    const send = buttons.find((button) => button.text().includes("Send"));
    expect(save?.attributes("disabled")).toBeUndefined();
    expect(send?.attributes("disabled")).toBeUndefined();
    await send?.trigger("click");
    expect(wrapper.emitted("execute")?.[0]?.[0]).toMatchObject({
      targetUrl: "<<base_url>>/resource",
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(wrapper.emitted("preview")).toEqual([[["base_url"]]]);
    vi.useRealTimers();
  });

  it("allows an unnamed temporary request to open the naming dialog", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(RequestEditor, {
      props: {
        request: null,
        draft: {
          name: "",
          method: "GET",
          targetUrl: "https://example.test/temporary",
          query: [],
          headers: [],
          body: "",
        },
        execution: null,
        tabId: "019facab-1eee-765f-bd9f-ac2449151be1",
        temporary: true,
        inheritedHeaders: [],
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    const save = wrapper
      .findAll(".command-bar button")
      .find((button) => button.text().includes("Save"))!;
    expect(save.attributes("disabled")).toBeUndefined();
    await save.trigger("click");
    expect(wrapper.emitted("save")).toEqual([
      [
        {
          name: "",
          method: "GET",
          targetUrl: "https://example.test/temporary",
          query: [],
          headers: [],
          body: "",
        },
      ],
    ]);
  });

  it("shows inherited headers as disabled fields beside local headers", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(RequestEditor, {
      props: {
        request: null,
        draft: {
          name: "Example",
          method: "GET",
          targetUrl: "https://example.test",
          query: [],
          headers: [{ name: "X-Local", value: "local", enabled: true }],
          body: "",
        },
        execution: null,
        tabId: "019facab-1eee-765f-bd9f-ac2449151be2",
        temporary: true,
        inheritedHeaders: [{ name: "X-Team", value: "shared", enabled: true }],
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    const headersTab = wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().startsWith("Headers"));
    expect(headersTab).toBeDefined();
    await headersTab?.trigger("click");
    const inheritedName = wrapper.get<HTMLInputElement>(
      'input[aria-label="Inherited header name 1"]',
    );
    expect(inheritedName.element.value).toBe("X-Team");
    expect(inheritedName.attributes("disabled")).toBeDefined();
    expect(
      wrapper
        .get('.inherited-header-indicator[role="img"]')
        .attributes("aria-label"),
    ).toBe("Inherited");
    expect(
      wrapper.get('input[aria-label="Header name 1"]').attributes("disabled"),
    ).toBeUndefined();
  });

  it("edits persisted request variables in a first-class request tab", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const requestId = "019facab-1eee-765f-bd9f-ac2449151be3";
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151be4";
    const wrapper = mount(RequestEditor, {
      props: {
        request: {
          requestId,
          workspaceId,
          parentCollectionId: null,
          name: "Saved request",
          method: "GET",
          targetMode: "absolute",
          targetUrl: "https://example.test",
          queryMode: "structured",
          query: [],
          headers: [],
          inheritedHeaders: [],
          body: "",
          draftRevision: 0,
        },
        draft: {
          name: "Saved request",
          method: "GET",
          targetUrl: "https://example.test",
          query: [],
          headers: [],
          body: "",
        },
        execution: null,
        tabId: "019facab-1eee-765f-bd9f-ac2449151be5",
        temporary: false,
        inheritedHeaders: [],
        requestVariableProfile: null,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().includes("Variables"))
      ?.trigger("click");
    expect(wrapper.emitted("loadVariables")).toHaveLength(1);
    await wrapper.setProps({
      requestVariableProfile: {
        workspaceId,
        scopeKind: "request",
        scopeId: requestId,
        scopeName: "Saved request",
        revision: 0,
        variables: [],
      },
    });
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Add variable"))
      ?.trigger("click");
    await wrapper.get('input[aria-label="Variable name 1"]').setValue("source");
    await wrapper
      .get('input[aria-label="Variable value 1"]')
      .setValue("request");
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Save request variables"))
      ?.trigger("click");
    expect(wrapper.emitted("saveVariables")).toEqual([
      [[{ name: "source", kind: "value", value: "request" }]],
    ]);
  });
});
