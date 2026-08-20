// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import type { RequestTab, WorkbenchTab } from "../src/model/domain/application";
import RequestTabs from "../src/view/presentation/features/RequestTabs.vue";

afterEach(() => document.body.replaceChildren());

/** Creates localization for the tab-strip presentation tests. */
function i18n() {
  return createI18n({
    legacy: false,
    locale: "en-US",
    messages: { "en-US": enUsMessages },
  });
}

/** Creates one clean request tab with the minimum complete workbench state. */
function requestWorkbenchTab(tabId: string, name: string): WorkbenchTab {
  const draft = {
    name,
    method: "GET" as const,
    targetMode: "absolute" as const,
    targetUrl: "https://example.test",
    query: [],
    headers: [],
    requestBody: { kind: "none" as const },
    body: "",
    preRequestScript: "",
    postResponseScript: "",
  };
  const requestTab: RequestTab = {
    tabId,
    workspaceId: "workspace",
    request: null,
    draft,
    baseline: structuredClone(draft),
    variableProfile: null,
    variableDraft: [],
    variableBaseline: [],
    pendingParentCollectionId: null,
    inheritedTarget: "",
    inheritedHeaders: [],
    execution: null,
    exchangeSummaries: [],
    selectedExchangeId: null,
    selectedExchange: null,
    revisions: [],
    viewingRevision: null,
    busy: false,
  };
  return { kind: "request", requestTab };
}

describe("RequestTabs", () => {
  it("offers active, other, and all tab-close actions", async () => {
    const first = requestWorkbenchTab("first-tab", "First");
    const second = requestWorkbenchTab("second-tab", "Second");
    const wrapper = mount(RequestTabs, {
      attachTo: document.body,
      props: { tabs: [first, second], activeTabId: "first-tab" },
      global: { plugins: [i18n()] },
    });

    const actions = wrapper.get<HTMLButtonElement>(
      'button[aria-label="Tab actions"]',
    );
    await actions.trigger("click");
    await flushPromises();
    let items = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    expect(items.map((item) => item.textContent)).toEqual([
      "Close current tab",
      "Close other tabs",
      "Close all tabs",
    ]);
    items[1]?.click();
    await flushPromises();
    expect(wrapper.emitted("closeOthers")).toEqual([["first-tab"]]);

    await actions.trigger("click");
    await flushPromises();
    items = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    items[2]?.click();
    await flushPromises();
    expect(wrapper.emitted("closeAll")).toEqual([[]]);

    await wrapper.setProps({ tabs: [first] });
    await actions.trigger("click");
    await flushPromises();
    items = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    expect(items[1]?.disabled).toBe(true);
    wrapper.unmount();
  });
});
