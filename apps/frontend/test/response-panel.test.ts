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
      createdAt: "2026-07-28T00:00:00.000Z",
      completedAt: "2026-07-28T00:00:01.000Z",
      error: {
        code: "execution_failed",
        message: "The proxy is unavailable.",
        errors: [],
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

    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toContain("execution_failed");
    expect(alert.text()).toContain("The proxy is unavailable.");
  });
});
