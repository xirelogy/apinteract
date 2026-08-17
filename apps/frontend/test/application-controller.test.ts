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
});

describe("ApplicationController requests", () => {
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
      command: vi.fn().mockResolvedValue(request),
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
