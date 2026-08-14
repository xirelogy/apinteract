// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import { officialTranslationPacks } from "../src/app/i18n/official-locales";
import {
  collectTemplateVariableNames,
  parseTemplateSegments,
} from "../src/model/domain/template-variables";
import TemplateTextControl from "../src/view/presentation/controls/TemplateTextControl.vue";

const applicationStyles = readFileSync(
  resolve(process.cwd(), "src/view/styling/components/application.css"),
  "utf8",
);
const controlStyles = readFileSync(
  resolve(process.cwd(), "src/view/styling/components/controls.css"),
  "utf8",
);

describe("template variable editing", () => {
  it("recognizes valid placeholders while preserving escapes and invalid text", () => {
    expect(
      collectTemplateVariableNames([
        "<<base_url>>/<<<<literal>>/<<token>>/<<base_url>>",
      ]),
    ).toEqual(["base_url", "token"]);
    expect(
      parseTemplateSegments("<<invalid name>>").find(
        (segment) => segment.kind === "variable",
      ),
    ).toMatchObject({ name: "invalid name", valid: false });
  });

  it("decorates kinds and inspects ordinary values without exposing secrets", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const modelValue = "<<base_url>>/resource?token=<<token>>";
    const source = {
      scope: "environment" as const,
      scopeId: "019facab-1eee-765f-bd9f-ac2449151bf0",
      scopeName: "Development",
      revision: 3,
    };
    const wrapper = mount(TemplateTextControl, {
      props: {
        modelValue,
        previews: [
          {
            name: "base_url",
            status: "resolved",
            declaredKind: "value",
            effectiveKind: "value",
            aliasTarget: null,
            value: "https://api.example.test",
            secretVersion: null,
            diagnostic: null,
            source,
          },
          {
            name: "token",
            status: "resolved",
            declaredKind: "secret",
            effectiveKind: "secret",
            aliasTarget: null,
            value: null,
            secretVersion: 7,
            diagnostic: null,
            source,
          },
        ],
      },
      global: { plugins: [i18n] },
    });

    expect(wrapper.get('[data-variable-name="base_url"]').classes()).toContain(
      "template-variable-token-kind-value",
    );
    expect(wrapper.get('[data-variable-name="token"]').classes()).toContain(
      "template-variable-token-kind-secret",
    );

    const input = wrapper.get<HTMLInputElement>("input");
    input.element.setSelectionRange(3, 3);
    await input.trigger("focus");
    await input.trigger("keyup");
    const ordinaryTooltip = wrapper.get('[role="tooltip"]');
    expect(ordinaryTooltip.text()).toContain("https://api.example.test");
    expect(ordinaryTooltip.attributes("style")).toMatch(/top: .*; left: .*/);

    const tokenPosition = modelValue.indexOf("<<token>>") + 3;
    input.element.setSelectionRange(tokenPosition, tokenPosition);
    await input.trigger("keyup");
    expect(wrapper.get('[role="tooltip"]').text()).toContain(
      "Secret value stored · version 7",
    );
    expect(wrapper.html()).not.toContain("top-secret-token");
  });

  it("localizes backend variable diagnostics at the presentation boundary", async () => {
    const zhHans = officialTranslationPacks.find(
      (pack) => pack.locale === "zh-Hans",
    );
    expect(zhHans).toBeDefined();
    const i18n = createI18n({
      legacy: false,
      locale: "zh-Hans",
      messages: { "zh-Hans": zhHans?.messages ?? enUsMessages },
    });
    const wrapper = mount(TemplateTextControl, {
      props: {
        modelValue: "<<missing_token>>",
        previews: [
          {
            name: "missing_token",
            status: "missing",
            declaredKind: null,
            effectiveKind: null,
            aliasTarget: null,
            value: null,
            secretVersion: null,
            diagnostic: "Variable missing_token is missing",
            source: null,
          },
        ],
      },
      global: { plugins: [i18n] },
    });

    const input = wrapper.get<HTMLInputElement>("input");
    input.element.setSelectionRange(3, 3);
    await input.trigger("focus");
    await input.trigger("keyup");
    const tooltip = wrapper.get('[role="tooltip"]');
    expect(tooltip.text()).toContain("变量 missing_token 不存在");
    expect(tooltip.text()).not.toContain("Variable missing_token is missing");
  });

  it("aligns compact decorations with merge-prefixed header values", () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const host = document.createElement("div");
    host.className = "header-value-field";
    host.style.setProperty("--control-height-compact", "32px");
    host.style.setProperty("--space-1", "4px");
    host.style.setProperty("--space-2", "8px");
    const headerInsetRule = applicationStyles.match(
      /\.header-value-field > \.field-cell-input,[\s\S]*?\}/u,
    )?.[0];
    const compactMirrorRule = controlStyles.match(
      /\.template-text-control:where\(\[data-density="compact"\]\)[\s\S]*?\}/u,
    )?.[0];
    expect(headerInsetRule).toBeDefined();
    expect(compactMirrorRule).toBeDefined();
    if (headerInsetRule === undefined || compactMirrorRule === undefined)
      return;
    const style = document.createElement("style");
    style.textContent = `
      .text-input-control-compact { padding-left: 8px; }
      ${compactMirrorRule}
      ${headerInsetRule}
    `
      .replaceAll("var(--control-height-compact)", "32px")
      .replaceAll("var(--space-1)", "4px")
      .replaceAll("calc(32px + 4px)", "36px")
      // JSDOM does not expose computed logical padding, so use its LTR equivalent.
      .replaceAll("padding-inline-start", "padding-left")
      .replaceAll("padding-inline:", "padding-left:");
    document.head.append(style);
    document.body.append(host);
    const wrapper = mount(TemplateTextControl, {
      attachTo: host,
      props: {
        modelValue: "Bearer <<token>>",
        previews: [],
        density: "compact",
        font: "mono",
      },
      attrs: { class: "field-template-input" },
      global: { plugins: [i18n] },
    });

    const inputPadding = getComputedStyle(
      wrapper.get(".template-text-control-input").element,
    ).paddingLeft;
    const mirrorPadding = getComputedStyle(
      wrapper.get(".template-text-control-mirror-content").element,
    ).paddingLeft;

    expect(inputPadding).not.toBe("");
    expect(mirrorPadding).toBe(inputPadding);
    wrapper.unmount();
    host.remove();
    style.remove();
  });
});
