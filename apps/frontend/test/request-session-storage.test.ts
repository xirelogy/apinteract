// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  BrowserRequestSessionStorage,
  redactSecretVariableWrites,
} from "../src/control/persistence/request-session-storage";

const userId = "019facab-1eee-765f-bd9f-ac2449151da1";

beforeEach(() => {
  window.localStorage.clear();
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
