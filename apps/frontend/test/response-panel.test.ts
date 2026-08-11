// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import type { ExecutionView } from "../src/model/contracts/backend";
import ResponsePanel from "../src/view/presentation/features/ResponsePanel.vue";

describe("ResponsePanel body transfer", () => {
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

    expect(wrapper.get(".body-preview").text()).toBe(
      "Binary or non-previewable response body.",
    );
    await wrapper
      .get('button[aria-label="Download response body"]')
      .trigger("click");
    expect(wrapper.emitted("download")).toEqual([[execution.executionId]]);
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

  it("retains useful partial response details after transport failure", () => {
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
      "Raw",
      "Headers 1",
    ]);
    expect(wrapper.get(".body-preview").text()).toBe("partial");
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
        },
      ],
      scriptError: {
        phase: "post-response",
        code: "runtime_error",
        message: "Example failure",
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
    expect(wrapper.get(".script-results").text()).not.toContain(
      "Unlocalized backend fallback",
    );
    expect(wrapper.get(".script-results").text()).toContain("Example failure");
    expect(wrapper.get(".script-results").text()).toContain(
      "Script failed while running",
    );
    expect(wrapper.get(".script-results").text()).toContain("runtime_error");
    expect(wrapper.get(".script-results").text()).toContain("Line 3, column 2");
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
        .get(".body-preview")
        .element.closest<HTMLElement>('[role="tabpanel"]')?.hidden,
    ).toBe(false);
  });
});
