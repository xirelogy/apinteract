// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { flushPromises, mount } from "@vue/test-utils";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import type {
  ExecutionView,
  RequestExchangeSummary,
} from "../src/model/contracts/backend";
import CodeEditor from "../src/view/presentation/controls/CodeEditor.vue";
import SelectMenu from "../src/view/presentation/controls/SelectMenu.vue";
import ResponsePanel from "../src/view/presentation/features/ResponsePanel.vue";
import { installApplicationTestPlugins } from "./plugin-fixtures";

installApplicationTestPlugins();

describe("ResponsePanel body transfer", () => {
  it("offers compact unified history and emits the selected exchange", async () => {
    const execution: ExecutionView = {
      executionId: "019fa8be-a510-76b9-b73b-69f4c7af7801",
      state: "completed",
      status: 201,
      bodyComplete: true,
      bodyBytes: 0,
      createdAt: "2026-07-28T00:00:00.000Z",
      completedAt: "2026-07-28T00:00:01.000Z",
      scriptLogs: [],
      scriptTests: [],
    };
    const exchanges: RequestExchangeSummary[] = [
      {
        exchangeId: execution.executionId,
        requestId: "019fa8be-a510-76b9-b73b-69f4c7af7802",
        requestRevisionId: null,
        kind: "execution",
        source: "apinteract",
        state: "completed",
        status: 201,
        bodyAvailability: "complete",
        occurredAt: execution.createdAt,
      },
      {
        exchangeId: "019fa8be-a510-76b9-b73b-69f4c7af7803",
        requestId: "019fa8be-a510-76b9-b73b-69f4c7af7802",
        requestRevisionId: null,
        kind: "capture",
        source: "har",
        label: "example",
        state: "completed",
        status: 200,
        bodyAvailability: "complete",
        occurredAt: "2026-07-27T23:00:00.000Z",
      },
    ];
    const wrapper = mount(ResponsePanel, {
      props: {
        execution,
        exchangeSummaries: exchanges,
        selectedExchangeId: execution.executionId,
      },
      global: {
        plugins: [
          createI18n({
            legacy: false,
            locale: "en-US",
            messages: { "en-US": enUsMessages },
          }),
        ],
      },
    });

    const select = wrapper.getComponent(SelectMenu);
    const options = select.props("options") as readonly {
      readonly value: string;
      readonly label: string;
    }[];
    const dateTime = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(execution.createdAt));
    expect(options[0]?.label).toBe(`201 · Execution · ${dateTime}`);
    expect(options[0]?.label).not.toContain("APInteract");
    expect(options[1]?.label).toContain("200 · example");
    expect(options[1]?.label).not.toContain("Imported response");
    select.vm.$emit("update:modelValue", exchanges[1]!.exchangeId);
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("selectExchange")).toEqual([
      [exchanges[1]!.exchangeId],
    ]);
  });

  it("shows the materialized outgoing request in its own result tab", async () => {
    const execution: ExecutionView = {
      executionId: "019fa8be-a510-76b9-b73b-69f4c7af7874",
      state: "completed",
      status: 200,
      bodyComplete: true,
      bodyBytes: 2,
      createdAt: "2026-07-28T00:00:00.000Z",
      completedAt: "2026-07-28T00:00:01.000Z",
      outgoingRequest: {
        method: "POST",
        url: { value: "https://example.test/items?id=1", redacted: false },
        headers: [
          {
            name: "Host",
            value: "example.test",
            redacted: false,
            derived: true,
          },
          {
            name: "content-type",
            value: "application/json",
            redacted: false,
            derived: false,
          },
          {
            name: "authorization",
            value: "[secret]",
            redacted: true,
            derived: false,
          },
        ],
        body: {
          value: '{"name":"test"}',
          encoding: "utf8",
          byteLength: 15,
          redacted: false,
          truncated: false,
        },
      },
      scriptLogs: [],
      scriptTests: [],
    };
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(ResponsePanel, {
      props: { execution },
      global: { plugins: [i18n] },
    });

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === "Request")
      ?.trigger("click");
    const request = wrapper.get(".outgoing-request-content");
    expect(request.text()).toContain("POST");
    expect(request.text()).toContain("https://example.test/items?id=1");
    expect(request.text()).toContain("authorization");
    expect(request.text()).toContain("[secret]");
    expect(request.text()).toContain("Host derived");
    expect(request.text()).toContain('{"name":"test"}');
  });

  it("keeps non-previewable bytes downloadable through an emitted action", async () => {
    const execution: ExecutionView = {
      executionId: "019fa8be-a510-76b9-b73b-69f4c7af7875",
      state: "completed",
      status: 200,
      headers: [{ name: "content-type", value: "application/octet-stream" }],
      bodyComplete: true,
      bodyBytes: 4,
      bodySha256: "digest",
      bodyBlobId: "019fa8be-a510-76b9-b73b-69f4c7af7876",
      createdAt: "2026-07-28T00:00:00.000Z",
      completedAt: "2026-07-28T00:00:01.000Z",
      scriptLogs: [],
      scriptTests: [],
    };
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(ResponsePanel, {
      props: { execution },
      global: { plugins: [i18n] },
    });

    const bodyState = wrapper.get(".response-body-state");
    expect(bodyState.text()).toContain(
      "Binary or non-previewable response body.",
    );
    expect(bodyState.text()).toContain("application/octet-stream");
    expect(bodyState.text()).toContain("4 bytes");
    expect(bodyState.text()).toContain("digest");
    await wrapper
      .get('button[aria-label="Download response body"]')
      .trigger("click");
    expect(wrapper.emitted("download")).toEqual([[execution.executionId]]);
  });

  it("explains when an imported HAR omitted its declared response body", () => {
    const execution: ExecutionView = {
      executionId: "019fa8be-a510-76b9-b73b-69f4c7af7877",
      state: "completed",
      status: 200,
      headers: [{ name: "content-type", value: "application/json" }],
      bodyComplete: false,
      bodyBytes: 84,
      createdAt: "2026-07-28T00:00:00.000Z",
      completedAt: "2026-07-28T00:00:01.000Z",
      scriptLogs: [],
      scriptTests: [],
    };
    const wrapper = mount(ResponsePanel, {
      props: { execution, capturedResponse: true },
      global: {
        plugins: [
          createI18n({
            legacy: false,
            locale: "en-US",
            messages: { "en-US": enUsMessages },
          }),
        ],
      },
    });

    expect(wrapper.get(".response-body-state").text()).toContain(
      "Response content was not included in the imported response.",
    );
  });

  it("exposes structured execution failures as an alert", () => {
    const execution: ExecutionView = {
      executionId: "019fa8be-a510-76b9-b73b-69f4c7af7875",
      state: "failed",
      bodyComplete: false,
      bodyBytes: 0,
      bodySha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      bodyBlobId: "019fa8be-a510-76b9-b73b-69f4c7af7876",
      createdAt: "2026-07-28T00:00:00.000Z",
      completedAt: "2026-07-28T00:00:01.000Z",
      error: {
        code: "execution_failed",
        message: "The proxy is unavailable.",
        errors: [],
      },
      scriptLogs: [],
      scriptTests: [],
    };
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(ResponsePanel, {
      props: { execution },
      global: { plugins: [i18n] },
    });

    const alert = wrapper.get('[role="alert"]');
    expect(alert.get("strong").text()).toBe("Request execution failed");
    expect(alert.text()).toContain("execution_failed");
    expect(alert.text()).toContain("The proxy is unavailable.");
    expect(wrapper.find('[role="tab"]').exists()).toBe(false);
    expect(wrapper.find(".response-summary").exists()).toBe(false);
    expect(
      wrapper.find('button[aria-label="Download response body"]').exists(),
    ).toBe(false);
  });

  it("makes an error the first tab when partial response data remains", async () => {
    const execution: ExecutionView = {
      executionId: "019fa8be-a510-76b9-b73b-69f4c7af7878",
      state: "failed",
      status: 502,
      headers: [{ name: "content-type", value: "text/plain" }],
      bodyComplete: false,
      bodyBytes: 7,
      bodyPreview: "partial",
      createdAt: "2026-07-28T00:00:00.000Z",
      completedAt: "2026-07-28T00:00:01.000Z",
      error: {
        code: "upstream_disconnected",
        message: "The upstream disconnected.",
        errors: [],
      },
      scriptLogs: [],
      scriptTests: [],
    };
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(ResponsePanel, {
      props: { execution },
      global: { plugins: [i18n] },
    });

    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
      "Error",
      "Raw",
      "Text",
      "Headers 1",
    ]);
    expect(wrapper.get('[role="tab"]').attributes("aria-selected")).toBe(
      "true",
    );
    expect(wrapper.get('[role="alert"]').text()).toContain(
      "The upstream disconnected.",
    );
    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === "Raw")
      ?.trigger("click");
    await vi.waitFor(() =>
      expect(wrapper.findComponent(CodeEditor).exists()).toBe(true),
    );
    expect(wrapper.getComponent(CodeEditor).props("modelValue")).toBe(
      "partial",
    );
  });

  it("keeps request and script data beside a tabbed execution error", async () => {
    const execution: ExecutionView = {
      executionId: "019fa8be-a510-76b9-b73b-69f4c7af7879",
      state: "failed",
      bodyComplete: false,
      bodyBytes: 0,
      createdAt: "2026-07-28T00:00:00.000Z",
      completedAt: "2026-07-28T00:00:01.000Z",
      error: {
        code: "execution_failed",
        message: "The post-processing step failed.",
        errors: [],
      },
      outgoingRequest: {
        method: "GET",
        url: { value: "https://example.test/items", redacted: false },
        headers: [],
        body: {
          value: "",
          encoding: "utf8",
          byteLength: 0,
          redacted: false,
          truncated: false,
        },
      },
      scriptLogs: [
        {
          sequence: 1,
          phase: "pre-request",
          level: "info",
          message: "request prepared",
        },
      ],
      scriptTests: [],
    };
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(ResponsePanel, {
      props: { execution },
      global: { plugins: [i18n] },
    });

    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
      "Error",
      "Request",
      "Scripts 1",
    ]);
    expect(wrapper.get('[role="alert"]').text()).toContain(
      "The post-processing step failed.",
    );

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === "Request")
      ?.trigger("click");
    expect(wrapper.get(".outgoing-request-content").text()).toContain(
      "https://example.test/items",
    );

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().startsWith("Scripts"))
      ?.trigger("click");
    expect(wrapper.get(".script-results").text()).toContain("request prepared");
  });

  it("shows script logs, tests, and post-response errors", async () => {
    const execution: ExecutionView = {
      executionId: "019fa8be-a510-76b9-b73b-69f4c7af7877",
      state: "completed",
      status: 200,
      bodyComplete: true,
      bodyBytes: 2,
      createdAt: "2026-07-28T00:00:00.000Z",
      completedAt: "2026-07-28T00:00:01.000Z",
      scriptLogs: [
        {
          sequence: 1,
          phase: "pre-request",
          level: "info",
          message: "prepared",
        },
      ],
      scriptTests: [
        {
          sequence: 2,
          name: "status is OK",
          status: "failed",
          message: "Unlocalized backend fallback",
          messageCode: "assertion_expected_truthy",
          code: "runtime_error",
          line: 7,
          column: 3,
        },
      ],
      scriptError: {
        phase: "post-response",
        code: "variable_write_conflict",
        message: "Variable token cannot be changed from secret to value",
        line: 3,
        column: 2,
      },
    };
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(ResponsePanel, {
      props: { execution },
      global: { plugins: [i18n] },
    });

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().startsWith("Scripts"))
      ?.trigger("click");
    expect(wrapper.get(".script-results").text()).toContain("prepared");
    expect(wrapper.get(".script-results").text()).toContain("status is OK");
    expect(wrapper.get(".script-results").text()).toContain(
      "Expected a truthy value",
    );
    expect(wrapper.get(".script-results").text()).toContain("Line 7, column 3");
    expect(wrapper.get(".script-results").text()).not.toContain(
      "Unlocalized backend fallback",
    );
    expect(wrapper.get(".script-results").text()).toContain(
      "Variable token cannot be changed from secret to value",
    );
    expect(wrapper.get(".script-results").text()).toContain(
      "The variable update conflicts with its current state",
    );
    expect(wrapper.get(".script-results").text()).toContain(
      "variable_write_conflict",
    );
    expect(wrapper.get(".script-results").text()).toContain("Line 3, column 2");
    const errorCard = wrapper
      .findAll(".script-result-card")
      .find((card) => card.attributes("data-kind") === "error");
    expect(errorCard).toBeDefined();
    expect(errorCard?.get(".script-result-card-header").text()).toBe(
      "ErrorPost-responsevariable_write_conflict",
    );
    expect(errorCard?.get(".script-result-error-details").text()).toBe(
      "The variable update conflicts with its current state — Variable token cannot be changed from secret to value · Line 3, column 2",
    );
    expect(errorCard?.element.children).toHaveLength(2);
    expect(
      wrapper
        .findAll(".script-result-card")
        .map((card) => card.attributes("data-kind")),
    ).toEqual(["log", "test", "error"]);

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().startsWith("Raw"))
      ?.trigger("click");
    expect(wrapper.get<HTMLElement>(".script-results").element.hidden).toBe(
      true,
    );
    expect(
      wrapper
        .get(".response-body-state")
        .element.closest<HTMLElement>('[role="tabpanel"]')?.hidden,
    ).toBe(false);
  });

  it("shows value-free receipts for committed script variable writes", async () => {
    const execution: ExecutionView = {
      executionId: "019fa8be-a510-76b9-b73b-69f4c7af7878",
      state: "completed",
      status: 200,
      bodyComplete: true,
      bodyBytes: 2,
      createdAt: "2026-07-28T00:00:00.000Z",
      completedAt: "2026-07-28T00:00:01.000Z",
      scriptLogs: [],
      scriptTests: [],
      scriptVariableWrites: [
        { name: "customerId", scope: "workspace", kind: "value" },
        {
          name: "accessToken",
          scope: "selected-environment",
          kind: "secret",
        },
      ],
    };
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(ResponsePanel, {
      props: { execution },
      global: { plugins: [i18n] },
    });

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().startsWith("Scripts"))
      ?.trigger("click");
    const receipts = wrapper.findAll(
      '.script-result-card[data-kind="variable"]',
    );
    expect(receipts).toHaveLength(2);
    expect(receipts[0]?.get(".script-result-card-header").text()).toBe(
      "VariablePost-responseSaved",
    );
    expect(receipts[0]?.get(".script-result-variable-details").text()).toBe(
      "customerIdWorkspace · Value",
    );
    expect(receipts[1]?.get(".script-result-variable-details").text()).toBe(
      "accessTokenSelected environment · Secret",
    );
  });

  it("keeps exact raw JSON beside a faithful formatted structured view", async () => {
    const source = '{"large":9007199254740993,"large":2}';
    const execution: ExecutionView = {
      executionId: "019fa8be-a510-76b9-b73b-69f4c7af7920",
      state: "completed",
      status: 200,
      headers: [{ name: "content-type", value: "application/json" }],
      bodyComplete: true,
      bodyBytes: source.length,
      bodyPreview: source,
      createdAt: "2026-08-29T00:00:00.000Z",
      completedAt: "2026-08-29T00:00:01.000Z",
      scriptLogs: [],
      scriptTests: [],
    };
    const wrapper = mount(ResponsePanel, {
      props: { execution },
      global: {
        plugins: [
          createI18n({
            legacy: false,
            locale: "en-US",
            messages: { "en-US": enUsMessages },
          }),
        ],
      },
    });

    await vi.waitFor(() =>
      expect(
        wrapper.find('[aria-label="Formatted JSON response body"]').exists(),
      ).toBe(true),
    );
    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
      "Raw",
      "JSON",
      "Headers 1",
      "Scripts 0",
    ]);
    const raw = wrapper.get<HTMLElement>('[aria-label="Raw response body"]');
    const structured = wrapper.get<HTMLElement>(
      '[aria-label="Formatted JSON response body"]',
    );
    expect(
      wrapper.find(".response-body-view > .plugin-view-host").exists(),
    ).toBe(true);
    expect(wrapper.find(".code-editor-plugin-view").exists()).toBe(true);
    expect(
      wrapper.find(".code-editor-plugin-view > .code-editor-control").exists(),
    ).toBe(true);
    expect(EditorView.findFromDOM(raw.element)?.state.doc.toString()).toBe(
      source,
    );
    expect(
      EditorView.findFromDOM(structured.element)?.state.doc.toString(),
    ).toBe('{\n  "large": 9007199254740993,\n  "large": 2\n}');
    expect(structured.attributes("data-language")).toBe("json");

    const rawPanel = raw.element.closest<HTMLElement>('[role="tabpanel"]');
    const jsonPanel =
      structured.element.closest<HTMLElement>('[role="tabpanel"]');
    expect(rawPanel?.hidden).toBe(true);
    expect(jsonPanel?.hidden).toBe(false);

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === "Raw")
      ?.trigger("click");
    expect(rawPanel?.hidden).toBe(false);
    expect(jsonPanel?.hidden).toBe(true);

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === "JSON")
      ?.trigger("click");
    expect(rawPanel?.hidden).toBe(true);
    expect(jsonPanel?.hidden).toBe(false);
  });

  it("keeps invalid structured content raw by default and lets its plugin explain the error", async () => {
    const source = '{"broken":}';
    const execution: ExecutionView = {
      executionId: "019fa8be-a510-76b9-b73b-69f4c7af7921",
      state: "completed",
      status: 200,
      headers: [{ name: "content-type", value: "application/json" }],
      bodyComplete: true,
      bodyBytes: source.length,
      bodyPreview: source,
      createdAt: "2026-08-29T00:00:00.000Z",
      completedAt: "2026-08-29T00:00:01.000Z",
      scriptLogs: [],
      scriptTests: [],
    };
    const wrapper = mount(ResponsePanel, {
      props: { execution },
      global: {
        plugins: [
          createI18n({
            legacy: false,
            locale: "en-US",
            messages: { "en-US": enUsMessages },
          }),
        ],
      },
    });

    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toContain(
      "JSON",
    );
    expect(
      wrapper
        .findAll('[role="tab"]')
        .find((tab) => tab.text() === "Raw")
        ?.attributes("aria-selected"),
    ).toBe("true");
    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === "JSON")
      ?.trigger("click");
    await vi.waitFor(() =>
      expect(wrapper.get(".response-preview-notice").text()).toContain(
        "could not be parsed as JSON",
      ),
    );
    const structured = wrapper.get<HTMLElement>(
      '[aria-label="Formatted JSON response body"]',
    );
    expect(
      EditorView.findFromDOM(structured.element)?.state.doc.toString(),
    ).toBe(source);
  });

  it("offers isolated HTML and loads raster bytes only after selecting Image", async () => {
    const html = "<h1>Safe preview</h1>";
    const htmlExecution: ExecutionView = {
      executionId: "019fa8be-a510-76b9-b73b-69f4c7af7922",
      state: "completed",
      status: 200,
      headers: [{ name: "content-type", value: "text/html" }],
      bodyComplete: true,
      bodyBytes: html.length,
      bodyPreview: html,
      createdAt: "2026-08-29T00:00:00.000Z",
      completedAt: "2026-08-29T00:00:01.000Z",
      scriptLogs: [],
      scriptTests: [],
    };
    const plugin = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const htmlWrapper = mount(ResponsePanel, {
      props: { execution: htmlExecution },
      global: { plugins: [plugin] },
    });
    expect(
      htmlWrapper.findAll('[role="tab"]').map((tab) => tab.text()),
    ).toContain("Preview");
    await htmlWrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === "Preview")
      ?.trigger("click");
    await vi.waitFor(() =>
      expect(htmlWrapper.find("iframe.html-response-preview").exists()).toBe(
        true,
      ),
    );
    expect(
      htmlWrapper.get("iframe.html-response-preview").attributes("srcdoc"),
    ).toContain(`<body>${html}</body>`);

    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    bytes.set([73, 72, 68, 82], 12);
    new DataView(bytes.buffer).setUint32(16, 1);
    new DataView(bytes.buffer).setUint32(20, 1);
    const body = new Blob([bytes]);
    const loadBody = vi.fn().mockResolvedValue(body);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const imageExecution: ExecutionView = {
      executionId: "019fa8be-a510-76b9-b73b-69f4c7af7923",
      state: "completed",
      status: 200,
      headers: [{ name: "content-type", value: "image/png" }],
      bodyComplete: true,
      bodyBytes: body.size,
      bodyBlobId: "019fa8be-a510-76b9-b73b-69f4c7af7924",
      createdAt: "2026-08-29T00:00:00.000Z",
      completedAt: "2026-08-29T00:00:01.000Z",
      scriptLogs: [],
      scriptTests: [],
    };
    const imageWrapper = mount(ResponsePanel, {
      props: {
        execution: imageExecution,
        loadBody,
      },
      global: {
        plugins: [
          createI18n({
            legacy: false,
            locale: "en-US",
            messages: { "en-US": enUsMessages },
          }),
        ],
      },
    });
    expect(imageWrapper.find(".image-response-preview").exists()).toBe(false);
    expect(loadBody).not.toHaveBeenCalled();
    await imageWrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === "Image")
      ?.trigger("click");
    await flushPromises();
    expect(imageWrapper.find(".image-response-preview").exists()).toBe(true);
    expect(loadBody).toHaveBeenCalledWith(
      "019fa8be-a510-76b9-b73b-69f4c7af7923",
    );
    imageWrapper.unmount();
  });
});
