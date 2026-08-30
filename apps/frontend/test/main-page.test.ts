// @vitest-environment jsdom

import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter } from "vue-router";
import { shallowMount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import { applicationControllerKey } from "../src/app/dependencies";
import { enUsMessages } from "../src/app/i18n/messages";
import type { ApplicationController } from "../src/control/application/application-controller";
import { useApplicationStore } from "../src/control/state/application-store";
import EnvironmentManager from "../src/view/presentation/features/EnvironmentManager.vue";
import CloseTabsDialog from "../src/view/presentation/features/CloseTabsDialog.vue";
import RequestEditor from "../src/view/presentation/features/RequestEditor.vue";
import { installApplicationTestPlugins } from "./plugin-fixtures";

installApplicationTestPlugins();
import RequestTabs from "../src/view/presentation/features/RequestTabs.vue";
import MainPage from "../src/view/presentation/pages/MainPage.vue";

describe("MainPage", () => {
  it("shows one workspace start state before a workspace is selected", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const controller = {
      initializeWorkspace: vi.fn().mockResolvedValue(undefined),
      session: { logout: vi.fn() },
    } as unknown as ApplicationController;
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: { template: "<div />" } }],
    });

    const wrapper = shallowMount(MainPage, {
      global: {
        plugins: [pinia, i18n, router],
        provide: { [applicationControllerKey as symbol]: controller },
      },
    });

    expect(wrapper.get(".workspace-empty-state").text()).toContain(
      "Start by creating or selecting a workspace",
    );
    expect(wrapper.findComponent(EnvironmentManager).exists()).toBe(false);
    expect(wrapper.findComponent(RequestTabs).exists()).toBe(false);
    expect(wrapper.findComponent(RequestEditor).exists()).toBe(false);
  });

  it("passes request revisions and unavailable capture bodies to the editor", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useApplicationStore();
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151cf0";
    const requestId = "019facab-1eee-765f-bd9f-ac2449151cf1";
    const revision = {
      revisionId: "019facab-1eee-765f-bd9f-ac2449151cf2",
      requestId,
      name: "Release",
      creationReason: "manual_save" as const,
      createdBy: "019facab-1eee-765f-bd9f-ac2449151cf3",
      createdByUsername: "alice",
      createdAt: "2026-08-13T01:00:00.000Z",
    };
    const request = {
      requestId,
      workspaceId,
      parentCollectionId: null,
      name: "Versioned request",
      description: "",
      notes: "",
      method: "GET" as const,
      targetMode: "absolute" as const,
      targetUrl: "https://example.test",
      inheritedTarget: "",
      queryMode: "structured" as const,
      query: [],
      headers: [],
      inheritedHeaders: [],
      body: "",
      preRequestScript: "",
      postResponseScript: "",
      draftRevision: 1,
    };
    store.$patch({
      selectedWorkspaceId: workspaceId,
      workspaces: [{ workspaceId, name: "Workspace", role: "owner" }],
      requestTabs: [
        {
          tabId: "request-tab",
          workspaceId,
          request,
          draft: {
            name: request.name,
            description: "",
            notes: "",
            method: request.method,
            targetMode: request.targetMode,
            targetUrl: request.targetUrl,
            query: [],
            headers: [],
            body: "",
            preRequestScript: "",
            postResponseScript: "",
          },
          baseline: null,
          variableProfile: null,
          variableDraft: null,
          variableBaseline: null,
          pendingParentCollectionId: null,
          inheritedTarget: "",
          inheritedHeaders: [],
          capturedExchange: {
            capturedExchangeId: "019facab-1eee-765f-bd9f-ac2449151cf4",
            source: "har",
            status: 200,
            statusText: "OK",
            headers: [],
            contentType: "application/json",
            body: "",
            bodyEncoding: "text",
            bodyComplete: true,
            bodyBytes: 84,
            recordedAt: null,
            importedAt: "2026-08-19T00:00:00.000Z",
          },
          execution: null,
          revisions: [revision],
          viewingRevision: null,
          busy: false,
        },
      ],
      activeRequestTabId: "request-tab",
    });
    const controller = {
      initializeWorkspace: vi.fn().mockResolvedValue(undefined),
      session: { logout: vi.fn() },
    } as unknown as ApplicationController;
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: { template: "<div />" } }],
    });

    const wrapper = shallowMount(MainPage, {
      global: {
        plugins: [pinia, i18n, router],
        provide: { [applicationControllerKey as symbol]: controller },
      },
    });

    expect(wrapper.getComponent(RequestEditor).props("revisions")).toEqual([
      revision,
    ]);
    expect(
      wrapper.getComponent(RequestEditor).props("execution"),
    ).not.toHaveProperty("bodyPreview");
    expect(wrapper.getComponent(RequestEditor).props("capturedResponse")).toBe(
      true,
    );
    expect(
      wrapper.getComponent(EnvironmentManager).attributes("revisions"),
    ).toBeUndefined();
  });

  it("confirms and closes all tabs only in the selected workspace", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useApplicationStore();
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151cf5";
    const otherWorkspaceId = "019facab-1eee-765f-bd9f-ac2449151cf6";
    const draft = {
      name: "Temporary request",
      description: "",
      notes: "",
      method: "GET" as const,
      targetMode: "absolute" as const,
      targetUrl: "",
      query: [],
      headers: [],
      requestBody: { kind: "none" as const },
      body: "",
      preRequestScript: "",
      postResponseScript: "",
    };
    /** Creates one temporary request tab for workspace-scoping assertions. */
    const requestTab = (tabId: string, tabWorkspaceId: string) => ({
      tabId,
      workspaceId: tabWorkspaceId,
      request: null,
      draft,
      baseline: null,
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
    });
    store.$patch({
      selectedWorkspaceId: workspaceId,
      workspaces: [{ workspaceId, name: "Workspace", role: "owner" }],
      requestTabs: [
        requestTab("visible-tab", workspaceId),
        requestTab("hidden-tab", otherWorkspaceId),
      ],
      activeRequestTabId: "visible-tab",
      activeWorkbenchTabId: "visible-tab",
      workbenchTabOrder: ["visible-tab", "hidden-tab"],
    });
    const closeWorkbenchTabs = vi.fn();
    const controller = {
      initializeWorkspace: vi.fn().mockResolvedValue(undefined),
      closeWorkbenchTabs,
      session: { logout: vi.fn() },
    } as unknown as ApplicationController;
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: { template: "<div />" } }],
    });
    const wrapper = shallowMount(MainPage, {
      global: {
        plugins: [pinia, i18n, router],
        provide: { [applicationControllerKey as symbol]: controller },
      },
    });

    expect(document.title).toBe("Temporary request · APInteract");
    store.requestTabs[0] = {
      ...store.requestTabs[0]!,
      draft: { ...draft, name: "Renamed request" },
    };
    await wrapper.vm.$nextTick();
    expect(document.title).toBe("Renamed request · APInteract");

    wrapper.getComponent(RequestTabs).vm.$emit("closeAll");
    await wrapper.vm.$nextTick();
    const confirmation = wrapper.getComponent(CloseTabsDialog);
    expect(confirmation.props()).toMatchObject({
      tabCount: 1,
      dirtyTabNames: ["Renamed request"],
      runningCount: 0,
    });
    expect(closeWorkbenchTabs).not.toHaveBeenCalled();

    confirmation.vm.$emit("confirm");
    expect(closeWorkbenchTabs).toHaveBeenCalledOnce();
    expect(closeWorkbenchTabs).toHaveBeenCalledWith(["visible-tab"]);
    wrapper.unmount();
    expect(document.title).toBe("APInteract");
  });
});
