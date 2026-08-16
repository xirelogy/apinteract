// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import type { RequestDraftInput } from "../src/model/domain/application";
import CodeEditor from "../src/view/presentation/controls/CodeEditor.vue";
import SelectMenu from "../src/view/presentation/controls/SelectMenu.vue";
import ScriptEditor from "../src/view/presentation/controls/ScriptEditor.vue";
import RequestEditor from "../src/view/presentation/features/RequestEditor.vue";

Object.defineProperty(Range.prototype, "getClientRects", {
  configurable: true,
  value: () => [],
});

describe("RequestEditor", () => {
  it("switches the whole editor to a read-only immutable version", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const requestId = "019facab-1eee-765f-bd9f-ac2449151bf0";
    const revisionId = "019facab-1eee-765f-bd9f-ac2449151bf1";
    const request = {
      requestId,
      workspaceId: "019facab-1eee-765f-bd9f-ac2449151bf2",
      parentCollectionId: null,
      name: "Current",
      method: "GET" as const,
      targetMode: "absolute" as const,
      targetUrl: "https://example.test/current",
      inheritedTarget: "",
      queryMode: "structured" as const,
      query: [],
      headers: [],
      inheritedHeaders: [],
      body: "current",
      preRequestScript: "",
      postResponseScript: "",
      draftRevision: 2,
    };
    const summary = {
      revisionId,
      requestId,
      name: "Release",
      creationReason: "manual_save" as const,
      createdBy: "019facab-1eee-765f-bd9f-ac2449151bf3",
      createdByUsername: "alice",
      createdAt: "2026-08-13T01:00:00.000Z",
    };
    const wrapper = mount(RequestEditor, {
      props: {
        request,
        draft: {
          name: request.name,
          method: request.method,
          targetMode: request.targetMode,
          targetUrl: request.targetUrl,
          query: [],
          headers: [],
          body: request.body,
          preRequestScript: "",
          postResponseScript: "",
        },
        execution: null,
        tabId: "version-tab",
        temporary: false,
        inheritedHeaders: [],
        busy: false,
        revisions: [summary],
        viewingRevision: {
          ...summary,
          request: {
            ...request,
            name: "Historical",
            method: "POST",
            targetUrl: "https://example.test/historical",
            body: "historical",
          },
        },
      },
      global: { plugins: [i18n] },
    });

    expect(
      wrapper.get('input[aria-label="Request name"]').element,
    ).toHaveProperty("value", "Historical");
    expect(
      wrapper.get('input[aria-label="Request name"]').attributes("disabled"),
    ).toBeDefined();
    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().includes("Versions"))
      ?.trigger("click");
    expect(wrapper.text()).toContain("Release");
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Current draft"))
      ?.trigger("click");
    expect(wrapper.emitted("selectRevision")).toEqual([[null]]);
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Send"))
      ?.trigger("click");
    expect(wrapper.emitted("executeRevision")).toEqual([[revisionId]]);
  });

  it("resizes the request and response panes by pointer and keyboard", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(RequestEditor, {
      props: {
        request: null,
        draft: {
          name: "Resizable request",
          method: "GET",
          targetMode: "absolute",
          targetUrl: "https://example.test",
          query: [],
          headers: [],
          body: "",
          requestBody: { kind: "none" },
          preRequestScript: "",
          postResponseScript: "",
        },
        execution: null,
        tabId: "019facab-1eee-765f-bd9f-ac2449151be8",
        temporary: true,
        inheritedHeaders: [],
        busy: false,
      },
      global: { plugins: [i18n] },
    });
    const workbench = wrapper.get(".request-workbench");
    vi.spyOn(workbench.element, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      left: 0,
      width: 1000,
      height: 800,
      toJSON: () => ({}),
    });
    const separator = wrapper.get('[role="separator"]');

    expect(separator.attributes("aria-label")).toBe(
      "Resize request and response panes",
    );
    expect(separator.attributes("aria-valuenow")).toBe("44");
    const pointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientY: 400,
    });
    Object.defineProperty(pointerDown, "pointerId", { value: 7 });
    separator.element.dispatchEvent(pointerDown);
    const pointerMove = new MouseEvent("pointermove", {
      bubbles: true,
      clientY: 560,
    });
    Object.defineProperty(pointerMove, "pointerId", { value: 7 });
    separator.element.dispatchEvent(pointerMove);
    await wrapper.vm.$nextTick();
    expect(workbench.attributes("data-resizing")).toBe("");
    expect(separator.attributes("aria-valuenow")).toBe("70");
    expect(workbench.attributes("style")).toContain(
      "--request-editor-share: 70%",
    );
    const pointerUp = new MouseEvent("pointerup", {
      bubbles: true,
      clientY: 560,
    });
    Object.defineProperty(pointerUp, "pointerId", { value: 7 });
    separator.element.dispatchEvent(pointerUp);
    await wrapper.vm.$nextTick();
    expect(workbench.attributes("data-resizing")).toBeUndefined();

    await separator.trigger("keydown", { key: "ArrowUp" });
    expect(separator.attributes("aria-valuenow")).toBe("66");
    wrapper.unmount();
  });

  it("edits JSON as semantic text and shows its generated Content-Type", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(RequestEditor, {
      props: {
        request: null,
        draft: {
          name: "JSON request",
          method: "POST",
          targetMode: "absolute",
          targetUrl: "https://example.test/json",
          query: [],
          headers: [
            {
              name: "Content-Type",
              value: "text/custom",
              enabled: true,
            },
          ],
          body: "",
          requestBody: { kind: "none" },
          preRequestScript: "",
          postResponseScript: "",
        },
        execution: null,
        tabId: "019facab-1eee-765f-bd9f-ac2449151cf0",
        temporary: true,
        inheritedHeaders: [],
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().startsWith("Body"))
      ?.trigger("click");
    const bodyType = wrapper
      .findAllComponents(SelectMenu)
      .find((select) => select.props("label") === "Content type");
    bodyType?.vm.$emit("update:modelValue", "json");
    await flushPromises();
    await vi.waitFor(() => {
      expect(wrapper.find(".body-code-editor").exists()).toBe(true);
    });
    const editor = wrapper.getComponent(CodeEditor);
    expect(editor.props("language")).toBe("json");
    editor.vm.$emit("update:modelValue", "{");
    editor.vm.$emit("input");
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("change")?.at(-1)?.[0]).toMatchObject({
      body: "{",
      requestBody: {
        kind: "text",
        contentType: "application/json",
        text: "{",
      },
    });
    bodyType?.vm.$emit("update:modelValue", "text");
    await wrapper.vm.$nextTick();
    expect(editor.props("language")).toBe("plain");
    expect(wrapper.emitted("change")?.at(-1)?.[0]).toMatchObject({
      body: "{",
      requestBody: { contentType: "text/plain", text: "{" },
    });
    bodyType?.vm.$emit("update:modelValue", "json");
    await wrapper.vm.$nextTick();
    expect(editor.props("language")).toBe("json");
    expect(wrapper.emitted("change")?.at(-1)?.[0]).toMatchObject({
      body: "{",
      requestBody: { contentType: "application/json", text: "{" },
    });

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().startsWith("Headers"))
      ?.trigger("click");
    expect(
      wrapper.get('input[aria-label="Generated header name"]').element,
    ).toHaveProperty("value", "Content-Type");
    expect(
      wrapper.find(".request-field-row.is-header-overridden").exists(),
    ).toBe(true);

    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Send"))
      ?.trigger("click");
    expect(wrapper.emitted("execute")?.at(-1)?.[0]).toMatchObject({
      requestBody: { kind: "text", text: "{" },
    });
  });

  it("uses an uploaded file as the complete body with an overridable media type", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const attachment = {
      attachmentId: "019facab-1eee-765f-bd9f-ac2449151cf4",
      workspaceId: "019facab-1eee-765f-bd9f-ac2449151cf5",
      fileName: "pixel.png",
      contentType: "image/png",
      byteLength: 4,
      sha256: "b".repeat(64),
    };
    const uploadAttachment = vi.fn().mockResolvedValue(attachment);
    const wrapper = mount(RequestEditor, {
      props: {
        request: null,
        draft: {
          name: "Binary request",
          method: "POST",
          targetMode: "absolute",
          targetUrl: "https://example.test/binary",
          query: [],
          headers: [],
          body: "",
          requestBody: { kind: "none" },
          preRequestScript: "",
          postResponseScript: "",
        },
        execution: null,
        tabId: "019facab-1eee-765f-bd9f-ac2449151cf6",
        temporary: true,
        inheritedHeaders: [],
        busy: false,
        uploadAttachment,
      },
      global: { plugins: [i18n] },
    });

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().startsWith("Body"))
      ?.trigger("click");
    const bodyType = wrapper
      .findAllComponents(SelectMenu)
      .find((select) => select.props("label") === "Content type");
    const bodyTypeOptions = bodyType?.props("options") as
      | Array<{ value: string; label: string }>
      | undefined;
    expect(bodyTypeOptions?.at(-1)).toEqual({
      value: "file",
      label: "Binary File",
    });
    bodyType?.vm.$emit("update:modelValue", "file");
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("Choose file");
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Choose file"))
      ?.trigger("click");

    const file = new File([new Uint8Array([137, 80, 78, 71])], "pixel.png", {
      type: "image/png",
    });
    const fileInput = wrapper.get<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(fileInput.element, "files", {
      configurable: true,
      value: [file],
    });
    await fileInput.trigger("change");
    await flushPromises();

    expect(uploadAttachment).toHaveBeenCalledWith(file);
    expect(wrapper.get(".request-file-name").text()).toBe("pixel.png");
    const contentType = wrapper.get<HTMLInputElement>(
      'input[aria-label="Content type override"]',
    );
    expect(contentType.attributes("placeholder")).toBe("image/png");
    expect(wrapper.emitted("change")?.at(-1)?.[0]).toMatchObject({
      requestBody: {
        kind: "file",
        contentType: null,
        attachment,
      },
    });

    await contentType.setValue("application/vnd.example.payload");
    expect(wrapper.emitted("change")?.at(-1)?.[0]).toMatchObject({
      requestBody: {
        kind: "file",
        contentType: "application/vnd.example.payload",
        attachment,
      },
    });
  });

  it("edits URL-encoded and multipart bodies as ordered form fields", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const attachment = {
      attachmentId: "019facab-1eee-765f-bd9f-ac2449151cf2",
      workspaceId: "019facab-1eee-765f-bd9f-ac2449151cf3",
      fileName: "payload.bin",
      contentType: "application/octet-stream",
      byteLength: 4,
      sha256: "a".repeat(64),
    };
    const uploadAttachment = vi.fn().mockResolvedValue(attachment);
    const wrapper = mount(RequestEditor, {
      props: {
        request: null,
        draft: {
          name: "Form request",
          method: "POST",
          targetMode: "absolute",
          targetUrl: "https://example.test/forms",
          query: [],
          headers: [],
          body: "",
          requestBody: {
            kind: "urlencoded",
            contentType: null,
            fields: [
              { name: "first", value: "one", enabled: true },
              { name: "second", value: "two", enabled: false },
            ],
          },
          preRequestScript: "",
          postResponseScript: "",
        },
        execution: null,
        tabId: "019facab-1eee-765f-bd9f-ac2449151cf1",
        temporary: true,
        inheritedHeaders: [],
        busy: false,
        uploadAttachment,
      },
      global: { plugins: [i18n] },
    });

    expect(wrapper.emitted("change")).toBeUndefined();
    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().startsWith("Body"))
      ?.trigger("click");
    const bodyType = wrapper
      .findAllComponents(SelectMenu)
      .find((select) => select.props("label") === "Content type");
    expect(bodyType?.props("modelValue")).toBe("urlencoded");
    expect(wrapper.find(".request-form-fields").exists()).toBe(true);
    expect(
      wrapper.get<HTMLInputElement>('input[aria-label="Form field name 1"]')
        .element.value,
    ).toBe("first");
    expect(
      wrapper.get<HTMLInputElement>('input[aria-label="Form field name 2"]')
        .element.value,
    ).toBe("second");
    expect(
      wrapper
        .get('input[aria-label="Form field name 3"]')
        .attributes("placeholder"),
    ).toBe("Add form field");

    await wrapper
      .get('input[aria-label="Form field name 3"]')
      .setValue("third");
    await wrapper.get('input[aria-label="Form field value 3"]').setValue("a+b");
    await wrapper
      .findAll<HTMLInputElement>(".request-form-fields input[type=checkbox]")[0]
      ?.setValue(false);
    const reorderHandles = wrapper.findAll(
      ".request-form-fields .row-reorder-handle",
    );
    await reorderHandles[0]?.trigger("keydown", {
      key: "ArrowDown",
      altKey: true,
    });
    expect(wrapper.emitted("change")?.at(-1)?.[0]).toMatchObject({
      body: "",
      requestBody: {
        kind: "urlencoded",
        contentType: null,
        fields: [
          { name: "second", value: "two", enabled: false },
          { name: "first", value: "one", enabled: false },
          { name: "third", value: "a+b", enabled: true },
        ],
      },
    });
    await wrapper
      .findAll(".request-form-fields .compact-icon-button")[1]
      ?.trigger("click");
    expect(wrapper.emitted("change")?.at(-1)?.[0]).toMatchObject({
      requestBody: {
        kind: "urlencoded",
        fields: [
          { name: "second", value: "two", enabled: false },
          { name: "third", value: "a+b", enabled: true },
        ],
      },
    });

    bodyType?.vm.$emit("update:modelValue", "multipart");
    await wrapper.vm.$nextTick();
    const multipartDraft = wrapper.emitted("change")?.at(-1)?.[0] as
      | RequestDraftInput
      | undefined;
    expect(multipartDraft).toMatchObject({
      body: "",
      requestBody: {
        kind: "multipart",
        contentType: null,
        fields: [
          { name: "second", value: "two", enabled: false },
          { name: "third", value: "a+b", enabled: true },
        ],
      },
    });
    const multipartBody = multipartDraft?.requestBody;
    if (multipartBody?.kind !== "multipart") {
      throw new Error("Missing multipart draft");
    }
    expect(multipartBody.boundary).toMatch(
      /^----APInteractBoundary[0-9a-f]{32}$/u,
    );

    expect(wrapper.text()).not.toContain("Attach files");
    await wrapper
      .get('input[aria-label="Form field name 3"]')
      .setValue("upload");
    const valueTypeToggles = wrapper.findAll(".form-value-type-toggle");
    expect(valueTypeToggles).toHaveLength(4);
    expect(valueTypeToggles[2]?.attributes("data-type")).toBe("text");
    await valueTypeToggles[2]?.trigger("click");
    expect(
      wrapper.findAll(".form-value-type-toggle")[2]?.attributes("data-type"),
    ).toBe("file");
    const attachFile = wrapper.get(".request-file-part-empty");
    expect(attachFile.text()).toBe("Attach file");
    await attachFile.trigger("click");

    const file = new File([new Uint8Array([0, 1, 2, 255])], "payload.bin", {
      type: "application/octet-stream",
    });
    const fileInput = wrapper.get<HTMLInputElement>('input[type="file"]');
    expect(fileInput.attributes("multiple")).toBeUndefined();
    Object.defineProperty(fileInput.element, "files", {
      configurable: true,
      value: [file],
    });
    await fileInput.trigger("change");
    await flushPromises();
    expect(uploadAttachment).toHaveBeenCalledWith(file);
    expect(wrapper.get(".request-file-name").text()).toBe("payload.bin");
    expect(wrapper.get(".request-file-metadata").text()).toContain(
      "application/octet-stream · 4 B",
    );
    const multipartWithFile = wrapper.emitted("change")?.at(-1)?.[0] as
      | RequestDraftInput
      | undefined;
    expect(multipartWithFile).toMatchObject({
      requestBody: {
        kind: "multipart",
        fields: [
          { name: "second", value: "two", enabled: false },
          { name: "third", value: "a+b", enabled: true },
          { kind: "file", name: "upload", enabled: true, attachment },
        ],
      },
    });
    expect(
      wrapper.findAll(".form-value-type-toggle")[2]?.attributes("data-type"),
    ).toBe("file");

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().startsWith("Headers"))
      ?.trigger("click");
    expect(
      wrapper.get<HTMLInputElement>('input[aria-label="Generated header name"]')
        .element.value,
    ).toBe("Content-Type");
    expect(
      wrapper.get<HTMLInputElement>(
        'input[aria-label="Generated header value"]',
      ).element.value,
    ).toBe(`multipart/form-data; boundary=${multipartBody.boundary}`);

    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Send"))
      ?.trigger("click");
    expect(wrapper.emitted("execute")?.at(-1)?.[0]).toMatchObject({
      requestBody: multipartWithFile?.requestBody,
    });

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().startsWith("Body"))
      ?.trigger("click");
    await wrapper.findAll(".form-value-type-toggle")[2]?.trigger("click");
    expect(wrapper.emitted("change")?.at(-1)?.[0]).toMatchObject({
      requestBody: {
        kind: "multipart",
        fields: [
          { name: "second", value: "two", enabled: false },
          { name: "third", value: "a+b", enabled: true },
          { name: "upload", value: "", enabled: true },
        ],
      },
    });
  });

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
          targetMode: "absolute",
          targetUrl: "https://example.test",
          query: [],
          headers: [],
          body: "",
          requestBody: { kind: "none" },
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
    await wrapper.get('input[aria-label="Query name 2"]').setValue("target");
    const queryHandles = wrapper.findAll(".row-reorder-handle");
    expect(queryHandles).toHaveLength(2);
    await queryHandles[0]?.trigger("keydown", {
      key: "ArrowDown",
      altKey: true,
    });
    expect(wrapper.emitted("change")?.at(-1)?.[0]).toMatchObject({
      query: [
        { name: "target", value: "", enabled: true },
        { name: "source", value: "", enabled: true },
      ],
    });

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().startsWith("Headers"))
      ?.trigger("click");
    const headerName = wrapper.get('input[aria-label="Header name 1"]');
    expect(headerName.attributes("placeholder")).toBe("Add header");
    await headerName.setValue("Cookie");
    const cookieMode = wrapper.findAll(".header-merge-mode-toggle")[0];
    expect(cookieMode?.attributes("data-mode")).toBe("append");
    expect(cookieMode?.attributes("title")).toBe("Append to inherited values");
    expect(
      wrapper
        .get('input[aria-label="Header name 2"]')
        .attributes("placeholder"),
    ).toBe("Add header");
    await wrapper.get('input[aria-label="Header name 2"]').setValue("X-Target");
    const headerHandles = wrapper.findAll(".row-reorder-handle");
    expect(headerHandles).toHaveLength(2);
    await headerHandles[0]?.trigger("keydown", {
      key: "ArrowDown",
      altKey: true,
    });
    expect(wrapper.emitted("change")?.at(-1)?.[0]).toMatchObject({
      query: [
        { name: "target", value: "", enabled: true },
        { name: "source", value: "", enabled: true },
      ],
      headers: [
        { name: "X-Target", value: "", enabled: true },
        { name: "Cookie", value: "", enabled: true, mode: "append" },
      ],
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
          targetMode: "absolute",
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

  it("previews and emits a composed request path", async () => {
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
          name: "Composed request",
          method: "GET",
          targetMode: "composed",
          targetUrl: "/42",
          query: [],
          headers: [],
          body: "",
          preRequestScript: "",
          postResponseScript: "",
        },
        execution: null,
        tabId: "019facab-1eee-765f-bd9f-ac2449151be7",
        temporary: true,
        inheritedTarget: "https://<<service_host>>/<<api_version>>/users/",
        inheritedHeaders: [],
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    const inheritedTarget = wrapper.get('input[aria-label="Inherited target"]');
    expect(inheritedTarget.attributes("readonly")).toBeDefined();
    expect(inheritedTarget.attributes("placeholder")).toBeUndefined();
    expect((inheritedTarget.element as HTMLInputElement).value).toBe(
      "https://<<service_host>>/<<api_version>>/users",
    );
    expect(
      wrapper.get(".inherited-target-input").attributes("style"),
    ).toContain("50ch");
    expect(
      wrapper
        .get(".inherited-target-input")
        .findAll(".template-variable-token")
        .map((token) => token.attributes("data-variable-name")),
    ).toEqual(["service_host", "api_version"]);
    expect(
      (
        wrapper.get('input[aria-label="Request path"]')
          .element as HTMLInputElement
      ).value,
    ).toBe("/42");
    const targetMode = wrapper.get('.target-mode-picker [role="combobox"]');
    expect(targetMode.text()).not.toContain("Composed");
    expect(targetMode.find("svg").exists()).toBe(true);
    await targetMode.trigger("click");
    expect(
      [...document.body.querySelectorAll('[role="option"]')].map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(["Composed", "Absolute"]);
    const send = wrapper
      .findAll(".command-bar button")
      .find((button) => button.text().includes("Send"));
    expect(send?.attributes("disabled")).toBeUndefined();
    await send?.trigger("click");
    expect(wrapper.emitted("execute")?.[0]?.[0]).toMatchObject({
      targetMode: "composed",
      targetUrl: "/42",
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(wrapper.emitted("preview")).toEqual([
      [["service_host", "api_version"]],
    ]);
    vi.useRealTimers();
  });

  it("does not treat a variable-bearing inherited path as an absolute base", () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(RequestEditor, {
      props: {
        request: null,
        draft: {
          name: "Missing base",
          method: "GET",
          targetMode: "composed",
          targetUrl: "/users",
          query: [],
          headers: [],
          body: "",
          preRequestScript: "",
          postResponseScript: "",
        },
        execution: null,
        tabId: "019facab-1eee-765f-bd9f-ac2449151be4",
        temporary: true,
        inheritedTarget: "/<<version>>",
        inheritedHeaders: [],
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    const send = wrapper
      .findAll(".command-bar button")
      .find((button) => button.text().includes("Send"));
    expect(send?.attributes("disabled")).toBeDefined();
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
          targetMode: "absolute",
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
          targetMode: "absolute",
          targetUrl: "https://example.test/temporary",
          query: [],
          headers: [],
          body: "",
          requestBody: { kind: "none" },
          preRequestScript: "",
          postResponseScript: "",
        },
      ],
    ]);
  });

  it("shows inherited headers as read-only fields beside local headers", async () => {
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
          targetMode: "absolute",
          targetUrl: "https://example.test",
          query: [],
          headers: [
            {
              name: "X-Team",
              value: "local",
              enabled: true,
              mode: "override",
            },
          ],
          body: "",
          preRequestScript: "",
          postResponseScript: "",
        },
        execution: null,
        tabId: "019facab-1eee-765f-bd9f-ac2449151be2",
        temporary: true,
        inheritedHeaders: [
          { name: "X-Team", value: "<<team>>", enabled: true },
        ],
        variablePreviews: [
          {
            name: "team",
            status: "resolved",
            declaredKind: "value",
            effectiveKind: "value",
            aliasTarget: null,
            value: "platform",
            secretVersion: null,
            diagnostic: null,
            source: {
              scope: "collection",
              scopeId: "019facab-1eee-765f-bd9f-ac2449151be3",
              scopeName: "Shared",
              revision: 1,
            },
          },
        ],
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
    const inheritedValue = wrapper.get<HTMLInputElement>(
      'input[aria-label="Inherited header value 1"]',
    );
    expect(inheritedValue.attributes("readonly")).toBeDefined();
    expect(inheritedValue.attributes("disabled")).toBeUndefined();
    inheritedValue.element.setSelectionRange(3, 3);
    await inheritedValue.trigger("focus");
    await inheritedValue.trigger("keyup");
    expect(wrapper.get('[role="tooltip"]').text()).toContain("platform");
    expect(
      wrapper
        .get('.inherited-header-indicator[role="img"]')
        .attributes("aria-label"),
    ).toBe("Overridden by this scope");
    expect(wrapper.get(".inherited-header-row").classes()).toContain(
      "is-header-overridden",
    );
    await wrapper.get(".header-merge-mode-toggle").trigger("click");
    expect(wrapper.get(".inherited-header-row").classes()).not.toContain(
      "is-header-overridden",
    );
    expect(wrapper.emitted("change")?.at(-1)?.[0]).toMatchObject({
      headers: [
        {
          name: "X-Team",
          value: "local",
          enabled: true,
          mode: "append",
        },
      ],
    });
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
          inheritedTarget: "",
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
          targetMode: "absolute",
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
        inheritedVariables: [],
      },
    });
    const variablesTab = wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().includes("Variables"));
    expect(variablesTab?.text()).toContain("0");
    expect(wrapper.find('.inline-warning[role="alert"]').exists()).toBe(false);
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
    expect(
      wrapper
        .findAll("button")
        .some((button) => button.text().includes("Save request variables")),
    ).toBe(false);
    expect(wrapper.emitted("changeVariables")?.at(-1)).toEqual([
      [{ name: "source", kind: "value", value: "request" }],
    ]);
    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "Save")
      ?.trigger("click");
    expect(wrapper.emitted("save")).toHaveLength(1);
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
          targetMode: "absolute",
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
