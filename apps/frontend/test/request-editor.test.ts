// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import ScriptEditor from "../src/view/presentation/controls/ScriptEditor.vue";
import RequestEditor from "../src/view/presentation/features/RequestEditor.vue";

Object.defineProperty(Range.prototype, "getClientRects", {
  configurable: true,
  value: () => [],
});

describe("RequestEditor", () => {
  it("keeps one trailing blank query and header row out of draft changes", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(RequestEditor, {
      props: {
        request: null,
        draft: {
          name: "Trailing rows",
          method: "GET",
          targetUrl: "https://example.test",
          query: [],
          headers: [],
          body: "",
          preRequestScript: "",
          postResponseScript: "",
        },
        execution: null,
        tabId: "019facab-1eee-765f-bd9f-ac2449151be9",
        temporary: true,
        inheritedHeaders: [],
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    const queryName = wrapper.get('input[aria-label="Query name 1"]');
    expect(queryName.attributes("placeholder")).toBe("Add parameter");
    expect(
      wrapper.get(".request-field-row .new-row-marker").element.tagName,
    ).toBe("SPAN");
    await queryName.setValue("source");
    expect(
      wrapper.get('input[aria-label="Query name 2"]').attributes("placeholder"),
    ).toBe("Add parameter");
    expect(wrapper.findAll(".request-field-row .new-row-marker")).toHaveLength(
      1,
    );
    expect(wrapper.emitted("change")?.at(-1)?.[0]).toMatchObject({
      query: [{ name: "source", value: "", enabled: true }],
      headers: [],
    });

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().startsWith("Headers"))
      ?.trigger("click");
    const headerName = wrapper.get('input[aria-label="Header name 1"]');
    expect(headerName.attributes("placeholder")).toBe("Add header");
    await headerName.setValue("X-Source");
    expect(
      wrapper
        .get('input[aria-label="Header name 2"]')
        .attributes("placeholder"),
    ).toBe("Add header");
    expect(wrapper.emitted("change")?.at(-1)?.[0]).toMatchObject({
      query: [{ name: "source", value: "", enabled: true }],
      headers: [{ name: "X-Source", value: "", enabled: true }],
    });
  });

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
          preRequestScript: "",
          postResponseScript: "",
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
          preRequestScript: "",
          postResponseScript: "",
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
          preRequestScript: "",
          postResponseScript: "",
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
          preRequestScript: "",
          postResponseScript: "",
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
          preRequestScript: "",
          postResponseScript: "",
          draftRevision: 0,
        },
        draft: {
          name: "Saved request",
          method: "GET",
          targetUrl: "https://example.test",
          query: [],
          headers: [],
          body: "",
          preRequestScript: "",
          postResponseScript: "",
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
    const variablesTab = wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().includes("Variables"));
    expect(variablesTab?.text()).toContain("0");
    const warning = wrapper.get('.inline-warning[role="alert"]');
    expect(warning.text()).toContain("Request-level override");
    expect(warning.text()).toContain(
      "Variables defined here take precedence over collection, environment, and workspace variables with the same name.",
    );
    const variableName = wrapper.get('input[aria-label="Variable name 1"]');
    expect(variableName.attributes("placeholder")).toBe("Add variable");
    await variableName.setValue("source");
    expect(variablesTab?.text()).toContain("1");
    expect(
      wrapper
        .get('input[aria-label="Variable name 2"]')
        .attributes("placeholder"),
    ).toBe("Add variable");
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

  it("edits both script phases from the request settings", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(RequestEditor, {
      props: {
        request: null,
        draft: {
          name: "Scripted request",
          method: "GET",
          targetUrl: "https://example.test",
          query: [],
          headers: [],
          body: "",
          preRequestScript: 'asdk.log.info("before");',
          postResponseScript: 'asdk.test("ok", () => {});',
        },
        execution: null,
        tabId: "019facab-1eee-765f-bd9f-ac2449151be6",
        temporary: true,
        inheritedHeaders: [],
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().startsWith("Pre-request"))
      ?.trigger("click");
    await flushPromises();
    await vi.waitFor(() => {
      expect(wrapper.find(".script-editor-control").exists()).toBe(true);
    });
    const preRequest = wrapper.getComponent(ScriptEditor);
    expect(preRequest.props("modelValue")).toContain("before");
    expect(
      preRequest.get('.cm-content[aria-label="Pre-request script"]').text(),
    ).toContain("before");
    expect(preRequest.findAll(".cm-line span").length).toBeGreaterThan(0);
    expect(preRequest.find("[placeholder]").exists()).toBe(false);
    expect(wrapper.findComponent(ScriptEditor).exists()).toBe(true);
    preRequest.vm.$emit("update:modelValue", 'asdk.request.setMethod("POST");');
    preRequest.vm.$emit("input");
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("change")?.at(-1)?.[0]).toMatchObject({
      preRequestScript: 'asdk.request.setMethod("POST");',
      postResponseScript: 'asdk.test("ok", () => {});',
    });
    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().startsWith("Post-response"))
      ?.trigger("click");
    await flushPromises();
    await vi.waitFor(() => {
      expect(wrapper.find(".script-editor-control").exists()).toBe(true);
    });
    const postResponse = wrapper.getComponent(ScriptEditor);
    expect(postResponse.props("modelValue")).toContain("ok");
    expect(
      postResponse.get('.cm-content[aria-label="Post-response script"]').text(),
    ).toContain("ok");
    expect(postResponse.find("[placeholder]").exists()).toBe(false);
  });
});
