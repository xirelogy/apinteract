// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BrowserRequestSessionStorage,
  redactSecretVariableWrites,
} from "../src/control/persistence/request-session-storage";

const userId = "019facab-1eee-765f-bd9f-ac2449151da1";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BrowserRequestSessionStorage", () => {
  it("retains the small per-user manifest when IndexedDB is unavailable", async () => {
    const storage = new BrowserRequestSessionStorage();
    const snapshot = {
      selectedWorkspaceId: "019facab-1eee-765f-bd9f-ac2449151da2",
      activeRequestTabId: "019facab-1eee-765f-bd9f-ac2449151da3",
      tabs: [
        {
          tabId: "019facab-1eee-765f-bd9f-ac2449151da3",
          workspaceId: "019facab-1eee-765f-bd9f-ac2449151da2",
          requestId: "019facab-1eee-765f-bd9f-ac2449151da4",
          baseDraftRevision: 3,
          baseVariableRevision: null,
          pendingParentCollectionId: null,
          draft: {
            name: "Saved request",
            method: "GET" as const,
            targetMode: "absolute" as const,
            targetUrl: "https://example.test",
            query: [],
            headers: [],
            requestBody: { kind: "none" as const },
            body: "",
            preRequestScript: "",
            postResponseScript: "",
          },
          draftDirty: false,
          variableDraft: null,
          variableDirty: false,
          omittedSecretValues: false,
          recoveryWarnings: [],
        },
      ],
    };

    await storage.save(userId, snapshot);

    await expect(storage.load(userId)).resolves.toEqual({
      selectedWorkspaceId: snapshot.selectedWorkspaceId,
      activeRequestTabId: snapshot.activeRequestTabId,
      tabs: [
        {
          tabId: snapshot.tabs[0]?.tabId,
          workspaceId: snapshot.tabs[0]?.workspaceId,
          requestId: snapshot.tabs[0]?.requestId,
          snapshot: null,
        },
      ],
    });
    await expect(
      storage.load("019facab-1eee-765f-bd9f-ac2449151da5"),
    ).resolves.toBeNull();
  });

  it("rejects malformed localStorage manifests", async () => {
    window.localStorage.setItem(
      `apinteract.request-session.v1:${userId}`,
      JSON.stringify({ version: 1, userId, tabs: "invalid" }),
    );

    await expect(
      new BrowserRequestSessionStorage().load(userId),
    ).resolves.toBeNull();
  });

  it("forgets removed tabs even when IndexedDB cleanup fails", async () => {
    const workspaceId = "019facab-1eee-765f-bd9f-ac2449151db2";
    const tabId = "019facab-1eee-765f-bd9f-ac2449151db3";
    const snapshot = {
      selectedWorkspaceId: workspaceId,
      activeRequestTabId: tabId,
      tabs: [
        {
          tabId,
          workspaceId,
          requestId: null,
          baseDraftRevision: null,
          baseVariableRevision: null,
          pendingParentCollectionId: null,
          draft: {
            name: "Temporary request",
            method: "GET" as const,
            targetMode: "absolute" as const,
            targetUrl: "",
            query: [],
            headers: [],
            requestBody: { kind: "none" as const },
            body: "",
            preRequestScript: "",
            postResponseScript: "",
          },
          draftDirty: true,
          variableDraft: [],
          variableDirty: false,
          omittedSecretValues: false,
          recoveryWarnings: [],
        },
      ],
    };
    await new BrowserRequestSessionStorage().save(userId, snapshot);
    const database = {
      close: vi.fn(),
      transaction: vi.fn(() => {
        throw new Error("IndexedDB cleanup failed");
      }),
    } as unknown as IDBDatabase;
    const openRequest = {
      result: database,
      onsuccess: null,
      onerror: null,
      onblocked: null,
      onupgradeneeded: null,
    } as unknown as IDBOpenDBRequest;
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => {
        queueMicrotask(() => {
          openRequest.onsuccess?.(new Event("success"));
        });
        return openRequest;
      }),
    });

    await expect(
      new BrowserRequestSessionStorage().save(userId, {
        selectedWorkspaceId: workspaceId,
        activeRequestTabId: null,
        tabs: [],
      }),
    ).rejects.toThrow("IndexedDB cleanup failed");

    expect(
      JSON.parse(
        window.localStorage.getItem(
          `apinteract.request-session.v1:${userId}`,
        ) ?? "null",
      ),
    ).toMatchObject({ activeRequestTabId: null, tabs: [] });
  });
});

describe("redactSecretVariableWrites", () => {
  it("removes only plaintext secret values while retaining safe mutations", () => {
    expect(
      redactSecretVariableWrites([
        { name: "token", kind: "secret", value: "do-not-store" },
        { name: "old-token", kind: "secret", clearValue: true },
        { name: "host", kind: "value", value: "example.test" },
      ]),
    ).toEqual({
      variables: [
        { name: "token", kind: "secret" },
        { name: "old-token", kind: "secret", clearValue: true },
        { name: "host", kind: "value", value: "example.test" },
      ],
      omittedSecretValues: true,
    });
  });
});
