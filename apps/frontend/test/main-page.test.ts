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
import RequestEditor from "../src/view/presentation/features/RequestEditor.vue";
import MainPage from "../src/view/presentation/pages/MainPage.vue";

describe("MainPage", () => {
  it("passes request revisions to the request editor", () => {
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
      wrapper.getComponent(EnvironmentManager).attributes("revisions"),
    ).toBeUndefined();
  });
});
