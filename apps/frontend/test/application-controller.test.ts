import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApplicationController } from "../src/control/application/application-controller";
import type {
  LocalRequestSessionSnapshot,
  RequestSessionStorage,
  RestoredRequestSession,
} from "../src/control/persistence/request-session-storage";
import type { SessionController } from "../src/control/session/session-controller";
import { useApplicationStore } from "../src/control/state/application-store";
import type { BackendWebSocketClient } from "../src/control/transport/websocket-client";
import { isRequestTabDirty } from "../src/model/domain/application";

class FakeRequestSessionStorage implements RequestSessionStorage {
  readonly saves: LocalRequestSessionSnapshot[] = [];
  readonly clearedUserIds: string[] = [];
  restored: RestoredRequestSession | null;

  constructor(restored: RestoredRequestSession | null = null) {
    this.restored = restored;
  }

  /** Returns the test's configured local session. */
  load(): Promise<RestoredRequestSession | null> {
    return Promise.resolve(this.restored);
  }

  /** Captures a detached copy of one persistence projection. */
  save(_userId: string, snapshot: LocalRequestSessionSnapshot): Promise<void> {
    this.saves.push(structuredClone(snapshot));
    return Promise.resolve();
  }

  /** Records local cleanup for the supplied user. */
  clear(userId: string): Promise<void> {
    this.clearedUserIds.push(userId);
    return Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ApplicationController workspaces", () => {
  it("loads visible workspaces without selecting a default", async () => {
    setActivePinia(createPinia());
    const workspaces = [
      {
        workspaceId: "019facab-1eee-765f-bd9f-ac2449151cd1",
        name: "First workspace",
        role: "owner" as const,
      },
      {
        workspaceId: "019facab-1eee-765f-bd9f-ac2449151cd2",
        name: "Second workspace",
        role: "viewer" as const,
      },
    ];
    const command = vi.fn().mockResolvedValue({ workspaces });
    const webSocket = {
      command,
      onEvent: vi.fn(),
    } as unknown as BackendWebSocketClient;
    const controller = new ApplicationController(
      {} as SessionController,
      webSocket,
    );

    await controller.initializeWorkspace();

    const store = useApplicationStore();
    expect(store.workspaces).toEqual(workspaces);
    expect(store.selectedWorkspaceId).toBeNull();
    expect(store.selectedWorkspace).toBeNull();
    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith("workspace.list", {});
  });

  it("clears workspace-derived state without a backend command", async () => {
    setActivePinia(createPinia());
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151ce1";
    const command = vi.fn();
    const webSocket = {
      command,
      onEvent: vi.fn(),
    } as unknown as BackendWebSocketClient;
    const controller = new ApplicationController(
      {} as SessionController,
      webSocket,
    );
    const store = useApplicationStore();
    store.$patch({
      selectedWorkspaceId: workspaceId,
      selectedWorkspace: {
        workspaceId,
        name: "Workspace",
        role: "owner",
        baseUrl: "https://example.test",
        headers: [],
        revision: 1,
      },
      environments: [
        {
          environmentId: "019facab-1eee-765f-bd9f-ac2449151ce2",
          name: "Local",
          revision: 1,
        },
      ],
      selectedEnvironmentId: "019facab-1eee-765f-bd9f-ac2449151ce2",
      selectedCollectionId: "019facab-1eee-765f-bd9f-ac2449151ce3",
      expandedCollectionIds: ["019facab-1eee-765f-bd9f-ac2449151ce3"],
    });

    await controller.selectWorkspace(null);

    expect(store.selectedWorkspaceId).toBeNull();
    expect(store.selectedWorkspace).toBeNull();
    expect(store.environments).toEqual([]);
    expect(store.selectedEnvironmentId).toBeNull();
    expect(store.selectedCollectionId).toBeNull();
    expect(store.expandedCollectionIds).toEqual([]);
    expect(command).not.toHaveBeenCalled();
  });
});

describe("ApplicationController local request recovery", () => {
  it("restores selected workspace, tab order, drafts, and stale warnings", async () => {
    setActivePinia(createPinia());
    const userId = "019facab-1eee-765f-bd9f-ac2449151db1";
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151db2";
    const requestId = "019facab-1eee-765f-bd9f-ac2449151db3";
    const savedTabId = "019facab-1eee-765f-bd9f-ac2449151db4";
    const temporaryTabId = "019facab-1eee-765f-bd9f-ac2449151db5";
    const request = {
      requestId,
      workspaceId,
      parentCollectionId: null,
      name: "Backend request",
      method: "GET" as const,
      targetMode: "absolute" as const,
      targetUrl: "https://example.test/backend",
      inheritedTarget: "",
      queryMode: "structured" as const,
      query: [],
      headers: [],
      inheritedHeaders: [],
      body: "",
      requestBody: { kind: "none" as const },
      preRequestScript: "",
      postResponseScript: "",
      draftRevision: 3,
    };
    const recoveredDraft = {
      name: "Recovered request",
      method: "POST" as const,
      targetMode: "absolute" as const,
      targetUrl: "https://example.test/recovered",
      query: [],
      headers: [],
      requestBody: { kind: "text" as const, contentType: null, text: "draft" },
      body: "draft",
      preRequestScript: "",
      postResponseScript: "",
    };
    const temporaryDraft = {
      ...recoveredDraft,
      name: "Temporary request",
    };
    const storage = new FakeRequestSessionStorage({
      selectedWorkspaceId: workspaceId,
      activeRequestTabId: temporaryTabId,
      tabs: [
        {
          tabId: savedTabId,
          workspaceId,
          requestId,
          snapshot: {
            tabId: savedTabId,
            workspaceId,
            requestId,
            baseDraftRevision: 2,
            baseVariableRevision: null,
            pendingParentCollectionId: null,
            draft: recoveredDraft,
            draftDirty: true,
            variableDraft: null,
            variableDirty: false,
            omittedSecretValues: false,
            recoveryWarnings: [],
          },
        },
        {
          tabId: temporaryTabId,
          workspaceId,
          requestId: null,
          snapshot: {
            tabId: temporaryTabId,
            workspaceId,
            requestId: null,
            baseDraftRevision: null,
            baseVariableRevision: null,
            pendingParentCollectionId: null,
            draft: temporaryDraft,
            draftDirty: true,
            variableDraft: [],
            variableDirty: false,
            omittedSecretValues: true,
            recoveryWarnings: ["secrets-omitted"],
          },
        },
      ],
    });
    const command = vi.fn((type: string) => {
      if (type === "workspace.list") {
        return {
          workspaces: [{ workspaceId, name: "Workspace", role: "owner" }],
        };
      }
      if (type === "tree.list") return { children: [] };
      if (type === "environment.list") {
        return { environments: [], selectedEnvironmentId: null };
      }
      if (type === "workspace.get") {
        return {
          workspaceId,
          name: "Workspace",
          role: "owner",
          baseUrl: "https://example.test",
          headers: [],
          revision: 1,
        };
      }
      if (type === "request.get") return request;
      if (type === "request.exchange.list") return { exchanges: [] };
      throw new Error(`Unexpected command ${type}`);
    });
    const session = { logout: vi.fn().mockResolvedValue(undefined) };
    const controller = new ApplicationController(
      session as unknown as SessionController,
      { command, onEvent: vi.fn() } as unknown as BackendWebSocketClient,
      storage,
    );
    const store = useApplicationStore();
    store.session = {
      sessionId: "019facab-1eee-765f-bd9f-ac2449151db6",
      user: { userId, username: "alice", displayName: "Alice" },
      createdAt: "2026-08-17T01:00:00.000Z",
      absoluteExpiresAt: "2026-08-18T01:00:00.000Z",
    };

    await controller.initializeWorkspace();

    expect(store.selectedWorkspaceId).toBe(workspaceId);
    expect(store.requestTabs.map((tab) => tab.tabId)).toEqual([
      savedTabId,
      temporaryTabId,
    ]);
    expect(store.activeRequestTabId).toBe(temporaryTabId);
    expect(store.requestTabs[0]?.draft.name).toBe("Recovered request");
    expect(store.requestTabs[0]?.recoveryWarnings).toContain("stale");
    expect(store.requestTabs[1]?.inheritedTarget).toBe("https://example.test");
    expect(store.requestTabs[1]?.recoveryWarnings).toContain("secrets-omitted");

    await controller.logout();
    expect(session.logout).toHaveBeenCalledOnce();
    expect(storage.clearedUserIds).toEqual([userId]);
  });

  it("persists tab manifests and redacts plaintext secret drafts", async () => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    const userId = "019facab-1eee-765f-bd9f-ac2449151dc1";
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151dc2";
    const tabId = "019facab-1eee-765f-bd9f-ac2449151dc3";
    const storage = new FakeRequestSessionStorage();
    const session = { logout: vi.fn().mockResolvedValue(undefined) };
    const controller = new ApplicationController(
      session as unknown as SessionController,
      {
        command: vi.fn().mockResolvedValue({ workspaces: [] }),
        onEvent: vi.fn(),
      } as unknown as BackendWebSocketClient,
      storage,
    );
    const store = useApplicationStore();
    store.session = {
      sessionId: "019facab-1eee-765f-bd9f-ac2449151dc4",
      user: { userId, username: "alice", displayName: "Alice" },
      createdAt: "2026-08-17T01:00:00.000Z",
      absoluteExpiresAt: "2026-08-18T01:00:00.000Z",
    };
    await controller.initializeWorkspace();
    store.$patch({
      activeRequestTabId: tabId,
      requestTabs: [
        {
          tabId,
          workspaceId,
          request: null,
          draft: {
            name: "Secret request",
            method: "GET",
            targetMode: "absolute",
            targetUrl: "https://example.test",
            query: [],
            headers: [],
            requestBody: { kind: "none" },
            body: "",
            preRequestScript: "",
            postResponseScript: "",
          },
          baseline: null,
          variableProfile: null,
          variableDraft: [
            { name: "token", kind: "secret", value: "do-not-store" },
          ],
          variableBaseline: [],
          pendingParentCollectionId: null,
          inheritedTarget: "",
          inheritedHeaders: [],
          execution: null,
          revisions: [],
          viewingRevision: null,
          busy: false,
        },
      ],
    });

    await vi.advanceTimersByTimeAsync(151);
    await Promise.resolve();

    const persistedTab = storage.saves.at(-1)?.tabs[0];
    expect(persistedTab?.variableDraft).toEqual([
      { name: "token", kind: "secret" },
    ]);
    expect(persistedTab?.omittedSecretValues).toBe(true);
    expect(persistedTab?.recoveryWarnings).toContain("secrets-omitted");
    await controller.logout();
  });

  it("persists a closed request tab without waiting for the debounce", async () => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    const userId = "019facab-1eee-765f-bd9f-ac2449151dd1";
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151dd2";
    const tabId = "019facab-1eee-765f-bd9f-ac2449151dd3";
    const storage = new FakeRequestSessionStorage();
    const controller = new ApplicationController(
      {
        logout: vi.fn().mockResolvedValue(undefined),
      } as unknown as SessionController,
      {
        command: vi.fn().mockResolvedValue({ workspaces: [] }),
        onEvent: vi.fn(),
      } as unknown as BackendWebSocketClient,
      storage,
    );
    const store = useApplicationStore();
    store.session = {
      sessionId: "019facab-1eee-765f-bd9f-ac2449151dd4",
      user: { userId, username: "alice", displayName: "Alice" },
      createdAt: "2026-08-17T01:00:00.000Z",
      absoluteExpiresAt: "2026-08-18T01:00:00.000Z",
    };
    await controller.initializeWorkspace();
    store.$patch({
      activeRequestTabId: tabId,
      requestTabs: [
        {
          tabId,
          workspaceId,
          request: null,
          draft: {
            name: "Temporary request",
            method: "GET",
            targetMode: "absolute",
            targetUrl: "",
            query: [],
            headers: [],
            requestBody: { kind: "none" },
            body: "",
            preRequestScript: "",
            postResponseScript: "",
          },
          baseline: null,
          variableProfile: null,
          variableDraft: [],
          variableBaseline: [],
          pendingParentCollectionId: null,
          inheritedTarget: "",
          inheritedHeaders: [],
          execution: null,
          revisions: [],
          viewingRevision: null,
          busy: false,
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(151);
    storage.saves.length = 0;

    controller.closeRequestTab(tabId);
    await Promise.resolve();
    await Promise.resolve();

    expect(storage.saves).toHaveLength(1);
    expect(storage.saves[0]?.tabs).toEqual([]);
    expect(storage.saves[0]?.activeRequestTabId).toBeNull();
    await controller.logout();
  });
});

describe("ApplicationController requests", () => {
  it("opens every captured import response and keeps the first active", async () => {
    setActivePinia(createPinia());
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151ae1";
    const collectionId = "019facab-1eee-765f-bd9f-ac2449151ae2";
    const importedRequests = [
      {
        requestId: "019facab-1eee-765f-bd9f-ac2449151ae3",
        captured: true,
      },
      {
        requestId: "019facab-1eee-765f-bd9f-ac2449151ae4",
        captured: false,
      },
      {
        requestId: "019facab-1eee-765f-bd9f-ac2449151ae5",
        captured: true,
      },
    ].map(({ requestId, captured }, index) => ({
      requestId,
      workspaceId,
      parentCollectionId: collectionId,
      name: `Imported ${index + 1}`,
      method: "GET" as const,
      targetMode: "absolute" as const,
      targetUrl: `https://example.test/${index + 1}`,
      inheritedTarget: "",
      queryMode: "structured" as const,
      query: [],
      headers: [],
      inheritedHeaders: [],
      requestBody: { kind: "none" as const },
      body: "",
      preRequestScript: "",
      postResponseScript: "",
      draftRevision: 0,
      ...(captured
        ? {
            capturedExchange: {
              capturedExchangeId: `019facab-1eee-765f-bd9f-ac2449151af${index}`,
              source: "har" as const,
              status: 200,
              statusText: "OK",
              headers: [],
              contentType: "text/plain",
              body: `response ${index + 1}`,
              bodyEncoding: "text" as const,
              bodyComplete: true,
              bodyBytes: 10,
              recordedAt: null,
              importedAt: "2026-08-19T00:00:00.000Z",
            },
          }
        : {}),
    }));
    const command = vi.fn((type: string, payload?: Record<string, string>) => {
      if (type === "import.apply") {
        return { collectionId, requests: importedRequests };
      }
      if (type === "tree.list") return { children: [] };
      if (type === "request.exchange.list") {
        const request = importedRequests.find(
          (candidate) => candidate.requestId === payload?.requestId,
        );
        const capture = request?.capturedExchange;
        return {
          exchanges:
            capture === undefined
              ? []
              : [
                  {
                    exchangeId: capture.capturedExchangeId,
                    requestId: request!.requestId,
                    requestRevisionId: null,
                    kind: "capture",
                    source: "har",
                    state: "completed",
                    status: capture.status,
                    bodyAvailability: "complete",
                    occurredAt: capture.importedAt,
                  },
                ],
        };
      }
      if (type === "request.exchange.get") {
        const request = importedRequests.find(
          (candidate) =>
            candidate.capturedExchange?.capturedExchangeId ===
            payload?.exchangeId,
        );
        if (request?.capturedExchange === undefined) {
          throw new Error("Missing captured exchange fixture");
        }
        return {
          summary: {
            exchangeId: request.capturedExchange.capturedExchangeId,
            requestId: request.requestId,
            requestRevisionId: null,
            kind: "capture",
            source: "har",
            state: "completed",
            status: request.capturedExchange.status,
            bodyAvailability: "complete",
            occurredAt: request.capturedExchange.importedAt,
          },
          execution: {
            executionId: request.capturedExchange.capturedExchangeId,
            requestId: request.requestId,
            state: "completed",
            status: request.capturedExchange.status,
            headers: request.capturedExchange.headers,
            bodyComplete: true,
            bodyBytes: request.capturedExchange.bodyBytes,
            bodyPreview: request.capturedExchange.body,
            createdAt: request.capturedExchange.importedAt,
            completedAt: request.capturedExchange.importedAt,
            scriptLogs: [],
            scriptTests: [],
          },
        };
      }
      throw new Error(`Unexpected command ${type}`);
    });
    const controller = new ApplicationController(
      {} as SessionController,
      { command, onEvent: vi.fn() } as unknown as BackendWebSocketClient,
    );
    const store = useApplicationStore();
    store.selectedWorkspaceId = workspaceId;

    await controller.applyImport({
      providerId: "har",
      sourceName: "capture.har",
      sourceText: "{}",
      plan: {
        schemaVersion: 1,
        providerId: "har",
        providerVersion: "1.0.0",
        sourceName: "capture.har",
        sourceFingerprint: "a".repeat(64),
        suggestedName: "Capture",
        pathPrefix: "",
        variables: [],
        collections: [],
        requests: [],
        diagnostics: [],
      },
      selectedItemIds: ["entry:0", "entry:1", "entry:2"],
      collectionName: "Capture",
      parentCollectionId: null,
    });

    expect(store.requestTabs.map((tab) => tab.request?.requestId)).toEqual([
      importedRequests[0]?.requestId,
      importedRequests[2]?.requestId,
    ]);
    expect(
      store.requestTabs.find((tab) => tab.tabId === store.activeRequestTabId)
        ?.request?.requestId,
    ).toBe(importedRequests[0]?.requestId);
    expect(store.requestTabs.map((tab) => tab.capturedExchange?.body)).toEqual([
      "response 1",
      "response 3",
    ]);
    expect(
      store.requestTabs.map((tab) => tab.selectedExchange?.summary.kind),
    ).toEqual(["capture", "capture"]);
  });

  it("defaults root requests to absolute targets and collection requests to composed targets", () => {
    setActivePinia(createPinia());
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151cd1";
    const collectionId = "019facab-1eee-765f-bd9f-ac2449151cd2";
    const webSocket = {
      command: vi.fn(),
      onEvent: vi.fn(),
    } as unknown as BackendWebSocketClient;
    const controller = new ApplicationController(
      {} as SessionController,
      webSocket,
    );
    const store = useApplicationStore();
    store.selectedWorkspaceId = workspaceId;

    controller.createTemporaryRequest();
    controller.createTemporaryRequest(collectionId);

    expect(store.requestTabs.map((tab) => tab.draft.targetMode)).toEqual([
      "absolute",
      "composed",
    ]);
  });

  it("flattens imported collection composition into a temporary request", () => {
    setActivePinia(createPinia());
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151cf1";
    const controller = new ApplicationController(
      {} as SessionController,
      {
        command: vi.fn(),
        onEvent: vi.fn(),
      } as unknown as BackendWebSocketClient,
    );
    const store = useApplicationStore();
    store.selectedWorkspaceId = workspaceId;
    store.selectedWorkspace = {
      workspaceId,
      name: "Workspace",
      role: "owner",
      baseUrl: "",
      headers: [],
      revision: 0,
    };
    const request = {
      itemId: "operation:GET:/items",
      sourceLocation: "#/paths/~1items/get",
      collectionKey: "server:one",
      name: "List items",
      method: "GET" as const,
      targetMode: "composed" as const,
      targetUrl: "/items/<<item>>",
      query: [],
      headers: [],
      requestBody: { kind: "none" as const },
      body: "",
      preRequestScript: "",
      postResponseScript: "",
      variables: [{ name: "version", kind: "value" as const, value: "v2" }],
    };
    const plan = {
      schemaVersion: 1 as const,
      providerId: "openapi-json" as const,
      providerVersion: "1.0.0",
      sourceName: "api.json",
      sourceFingerprint: "c".repeat(64),
      suggestedName: "API",
      pathPrefix: "https://api.example.test/<<version>>",
      variables: [{ name: "version", kind: "value" as const, value: "v1" }],
      collections: [
        {
          collectionKey: "server:one",
          parentCollectionKey: null,
          name: "Server",
          pathPrefix: "/<<region>>",
          variables: [
            { name: "region", kind: "value" as const, value: "eu" },
            { name: "item", kind: "value" as const, value: "first" },
          ],
        },
      ],
      requests: [request],
      diagnostics: [],
    };

    controller.createImportedTemporaryRequest(plan, request);

    expect(store.requestTabs[0]?.draft).toMatchObject({
      targetMode: "absolute",
      targetUrl:
        "https://api.example.test/<<version>>/<<region>>/items/<<item>>",
    });
    expect(store.requestTabs[0]?.variableDraft).toEqual([
      { name: "version", kind: "value", value: "v2" },
      { name: "region", kind: "value", value: "eu" },
      { name: "item", kind: "value", value: "first" },
    ]);
  });

  it("selects the latest saved exchange and can load an older capture", async () => {
    setActivePinia(createPinia());
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151ad1";
    const requestId = "019facab-1eee-765f-bd9f-ac2449151ad2";
    const executionId = "019facab-1eee-765f-bd9f-ac2449151ad3";
    const captureId = "019facab-1eee-765f-bd9f-ac2449151ad4";
    const liveExecutionId = "019facab-1eee-765f-bd9f-ac2449151ad5";
    const request = {
      requestId,
      workspaceId,
      parentCollectionId: null,
      name: "History",
      method: "GET" as const,
      targetMode: "absolute" as const,
      targetUrl: "https://example.test/history",
      inheritedTarget: "",
      queryMode: "structured" as const,
      query: [],
      headers: [],
      inheritedHeaders: [],
      requestBody: { kind: "none" as const },
      body: "",
      preRequestScript: "",
      postResponseScript: "",
      draftRevision: 1,
    };
    const summaries = [
      {
        exchangeId: executionId,
        requestId,
        requestRevisionId: null,
        kind: "execution" as const,
        source: "apinteract" as const,
        state: "completed" as const,
        status: 201,
        bodyAvailability: "complete" as const,
        occurredAt: "2026-08-19T02:00:00.000Z",
      },
      {
        exchangeId: captureId,
        requestId,
        requestRevisionId: null,
        kind: "capture" as const,
        source: "har" as const,
        state: "completed" as const,
        status: 200,
        bodyAvailability: "complete" as const,
        occurredAt: "2026-08-19T01:00:00.000Z",
      },
    ];
    const command = vi.fn((type: string, payload?: Record<string, string>) => {
      if (type === "request.get") return request;
      if (type === "request.exchange.list") return { exchanges: summaries };
      if (type === "request.exchange.get") {
        const summary = summaries.find(
          (candidate) => candidate.exchangeId === payload?.exchangeId,
        )!;
        return {
          summary,
          execution: {
            executionId: summary.exchangeId,
            requestId,
            state: "completed",
            status: summary.status,
            bodyComplete: true,
            bodyBytes: 4,
            bodyPreview: summary.kind,
            createdAt: summary.occurredAt,
            completedAt: summary.occurredAt,
            scriptLogs: [],
            scriptTests: [],
          },
        };
      }
      if (type === "execution.start_revision") {
        return {
          executionId: liveExecutionId,
          requestId,
          state: "running",
          bodyComplete: false,
          bodyBytes: 0,
          createdAt: "2026-08-19T03:00:00.000Z",
          scriptLogs: [],
          scriptTests: [],
        };
      }
      throw new Error(`Unexpected command ${type}`);
    });
    const controller = new ApplicationController(
      {} as SessionController,
      { command, onEvent: vi.fn() } as unknown as BackendWebSocketClient,
    );

    await controller.selectRequest(requestId);

    const tab = useApplicationStore().requestTabs[0]!;
    expect(tab.selectedExchangeId).toBe(executionId);
    expect(tab.selectedExchange?.execution.bodyPreview).toBe("execution");

    await controller.selectRequestExchange(tab.tabId, captureId);

    expect(useApplicationStore().requestTabs[0]?.selectedExchangeId).toBe(
      captureId,
    );
    expect(
      useApplicationStore().requestTabs[0]?.selectedExchange?.execution
        .bodyPreview,
    ).toBe("capture");

    await controller.executeRequestRevision(tab.tabId, "revision-id");

    expect(useApplicationStore().requestTabs[0]?.selectedExchangeId).toBe(
      liveExecutionId,
    );
    expect(
      useApplicationStore().requestTabs[0]?.exchangeSummaries[0],
    ).toMatchObject({
      exchangeId: liveExecutionId,
      kind: "execution",
      state: "running",
    });
  });

  it("opens persisted form bodies without sharing fields or becoming dirty", async () => {
    setActivePinia(createPinia());
    const requestId = "019facab-1eee-765f-bd9f-ac2449151bf1";
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151bf2";
    const request = {
      requestId,
      workspaceId,
      parentCollectionId: null,
      name: "Multipart request",
      method: "POST" as const,
      targetMode: "absolute" as const,
      targetUrl: "https://example.test/forms",
      inheritedTarget: "",
      queryMode: "structured" as const,
      query: [],
      headers: [],
      inheritedHeaders: [],
      body: '--PersistedBoundary\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n--PersistedBoundary--\r\n',
      requestBody: {
        kind: "multipart" as const,
        contentType: null,
        boundary: "PersistedBoundary",
        fields: [
          { name: "field", value: "value", enabled: true },
          {
            kind: "file" as const,
            name: "upload",
            enabled: true,
            attachment: {
              attachmentId: "019facab-1eee-765f-bd9f-ac2449151bf3",
              workspaceId,
              fileName: "payload.bin",
              contentType: "application/octet-stream",
              byteLength: 4,
              sha256: "a".repeat(64),
            },
          },
        ],
      },
      preRequestScript: "",
      postResponseScript: "",
      draftRevision: 2,
    };
    const webSocket = {
      command: vi.fn((type: string) =>
        type === "request.exchange.list" ? { exchanges: [] } : request,
      ),
      onEvent: vi.fn(),
    } as unknown as BackendWebSocketClient;
    const controller = new ApplicationController(
      {} as SessionController,
      webSocket,
    );

    await controller.selectRequest(requestId);

    const tab = useApplicationStore().requestTabs[0];
    if (tab === undefined) throw new Error("Missing opened request tab");
    expect(tab.draft).toMatchObject({
      body: "",
      requestBody: request.requestBody,
    });
    expect(isRequestTabDirty(tab)).toBe(false);
    if (
      tab.baseline === null ||
      tab.draft.requestBody?.kind !== "multipart" ||
      tab.baseline.requestBody?.kind !== "multipart"
    ) {
      throw new Error("Missing multipart draft");
    }
    expect(tab.draft.requestBody.fields).not.toBe(request.requestBody.fields);
    expect(tab.baseline.requestBody.fields).not.toBe(
      tab.draft.requestBody.fields,
    );
    const draftFile = tab.draft.requestBody.fields[1];
    const requestFile = request.requestBody.fields[1];
    if (
      draftFile === undefined ||
      !("kind" in draftFile) ||
      requestFile === undefined ||
      !("kind" in requestFile)
    ) {
      throw new Error("Missing multipart file fixture");
    }
    expect(draftFile.attachment).not.toBe(requestFile.attachment);
    controller.updateRequestDraft(tab.tabId, {
      ...tab.draft,
      requestBody: {
        ...tab.draft.requestBody,
        fields: tab.draft.requestBody.fields.map((field, index) =>
          index === 0 ? { ...field, value: "changed" } : field,
        ),
      },
    });
    const changedTab = useApplicationStore().requestTabs[0]!;
    if (
      changedTab.baseline === null ||
      changedTab.baseline.requestBody?.kind !== "multipart"
    ) {
      throw new Error("Missing multipart baseline");
    }
    expect(changedTab.baseline.requestBody.fields[0]).toMatchObject({
      value: "value",
    });
    expect(request.requestBody.fields[0]).toMatchObject({ value: "value" });
    expect(isRequestTabDirty(changedTab)).toBe(true);
  });

  it("persists dirty variables with the request and advances both baselines", async () => {
    setActivePinia(createPinia());
    const requestId = "019facab-1eee-765f-bd9f-ac2449151be1";
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151be2";
    const variableId = "019facab-1eee-765f-bd9f-ac2449151be3";
    const request = {
      requestId,
      workspaceId,
      parentCollectionId: null,
      name: "Saved request",
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
    const draft = {
      name: request.name,
      method: request.method,
      targetMode: request.targetMode,
      targetUrl: request.targetUrl,
      query: [],
      headers: [],
      body: "",
      preRequestScript: "",
      postResponseScript: "",
    };
    const profile = {
      workspaceId,
      scopeKind: "request" as const,
      scopeId: requestId,
      scopeName: request.name,
      revision: 2,
      variables: [
        { variableId, name: "source", kind: "value" as const, value: "before" },
      ],
      inheritedVariables: [],
    };
    const updatedProfile = {
      ...profile,
      revision: 3,
      variables: [{ ...profile.variables[0]!, value: "after" }],
    };
    const command = vi.fn((type: string) => {
      if (type === "request.update") return request;
      if (type === "variable_profile.get") return updatedProfile;
      if (type === "request.revision.list") return { revisions: [] };
      throw new Error(`Unexpected command ${type}`);
    });
    const webSocket = {
      command,
      onEvent: vi.fn(),
    } as unknown as BackendWebSocketClient;
    const controller = new ApplicationController(
      {} as SessionController,
      webSocket,
    );
    const store = useApplicationStore();
    store.requestTabs = [
      {
        tabId: "request-tab",
        workspaceId,
        request,
        draft,
        baseline: { ...draft },
        variableProfile: profile,
        variableDraft: [
          { variableId, name: "source", kind: "value", value: "after" },
        ],
        variableBaseline: [
          { variableId, name: "source", kind: "value", value: "before" },
        ],
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
      },
    ];
    expect(isRequestTabDirty(store.requestTabs[0]!)).toBe(true);

    await controller.saveRequest("request-tab", draft);

    expect(command).toHaveBeenNthCalledWith(
      1,
      "request.update",
      expect.objectContaining({
        requestId,
        expectedDraftRevision: 1,
        variableProfile: {
          expectedRevision: 2,
          variables: [
            { variableId, name: "source", kind: "value", value: "after" },
          ],
        },
      }),
    );
    expect(store.requestTabs[0]?.variableProfile?.revision).toBe(3);
    expect(
      store.requestTabs[0] && isRequestTabDirty(store.requestTabs[0]),
    ).toBe(false);
  });

  it("previews, executes, and saves temporary request variables", async () => {
    setActivePinia(createPinia());
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151ce1";
    const collectionId = "019facab-1eee-765f-bd9f-ac2449151ce2";
    const requestId = "019facab-1eee-765f-bd9f-ac2449151ce3";
    const variableId = "019facab-1eee-765f-bd9f-ac2449151ce4";
    const command = vi.fn((type: string) => {
      if (type === "variable_profile.get_temporary") {
        return {
          workspaceId,
          scopeKind: "request",
          scopeId: useApplicationStore().requestTabs[0]?.tabId,
          scopeName: "Temporary request",
          revision: 0,
          variables: [],
          inheritedVariables: [],
        };
      }
      if (type === "variable.preview") return { previews: [] };
      if (type === "execution.start_temporary") {
        return {
          executionId: "019facab-1eee-765f-bd9f-ac2449151ce5",
          state: "created",
          bodyComplete: false,
          createdAt: "2026-08-17T00:00:00.000Z",
          scriptLogs: [],
          scriptTests: [],
        };
      }
      if (type === "request.create") {
        return {
          requestId,
          workspaceId,
          parentCollectionId: collectionId,
          name: "Draft request",
          method: "GET",
          targetMode: "absolute",
          targetUrl: "https://example.test/<<source>>",
          inheritedTarget: "",
          queryMode: "structured",
          query: [],
          headers: [],
          inheritedHeaders: [],
          body: "",
          preRequestScript: "",
          postResponseScript: "",
          draftRevision: 0,
        };
      }
      if (type === "variable_profile.get") {
        expect(useApplicationStore().requestTabs[0]?.request?.requestId).toBe(
          requestId,
        );
        return {
          workspaceId,
          scopeKind: "request",
          scopeId: requestId,
          scopeName: "Draft request",
          revision: 1,
          variables: [
            {
              variableId,
              name: "source",
              kind: "value",
              value: "temporary",
            },
          ],
          inheritedVariables: [],
        };
      }
      if (type === "tree.list") return { children: [] };
      throw new Error(`Unexpected command ${type}`);
    });
    const webSocket = {
      command,
      onEvent: vi.fn(),
    } as unknown as BackendWebSocketClient;
    const controller = new ApplicationController(
      {} as SessionController,
      webSocket,
    );
    const store = useApplicationStore();
    store.selectedWorkspaceId = workspaceId;
    store.selectedWorkspace = {
      workspaceId,
      name: "Workspace",
      role: "owner",
      baseUrl: "",
      headers: [],
      revision: 0,
    };

    controller.createTemporaryRequest(collectionId);
    const tab = store.requestTabs[0];
    if (tab === undefined) throw new Error("Missing temporary request tab");
    controller.updateRequestDraft(tab.tabId, {
      ...tab.draft,
      name: "Draft request",
      targetMode: "absolute",
      targetUrl: "https://example.test/<<source>>",
    });
    await controller.loadTemporaryVariableProfile(tab.tabId);
    controller.updateRequestVariableDraft(tab.tabId, [
      { name: "source", kind: "value", value: "temporary" },
    ]);

    await controller.previewVariables(["source"]);
    expect(command).toHaveBeenLastCalledWith(
      "variable.preview",
      expect.objectContaining({
        parentCollectionId: collectionId,
        requestId: null,
        temporaryVariables: {
          scopeId: tab.tabId,
          scopeName: "Draft request",
          variables: [{ name: "source", kind: "value", value: "temporary" }],
        },
      }),
    );

    const currentDraft = store.requestTabs[0]!.draft;
    await controller.executeRequest(tab.tabId, currentDraft);
    expect(command).toHaveBeenCalledWith(
      "execution.start_temporary",
      expect.objectContaining({
        temporaryVariables: {
          scopeId: tab.tabId,
          scopeName: "Draft request",
          variables: [{ name: "source", kind: "value", value: "temporary" }],
        },
      }),
    );

    await controller.saveTemporaryRequest(
      tab.tabId,
      "Draft request",
      collectionId,
    );
    expect(command).toHaveBeenCalledWith(
      "request.create",
      expect.objectContaining({
        variables: [{ name: "source", kind: "value", value: "temporary" }],
      }),
    );
    expect(store.requestTabs[0]?.variableProfile?.scopeId).toBe(requestId);
    expect(
      store.requestTabs[0] && isRequestTabDirty(store.requestTabs[0]),
    ).toBe(false);
  });
});
