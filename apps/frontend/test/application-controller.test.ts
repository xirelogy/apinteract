import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it, vi } from "vitest";

import { ApplicationController } from "../src/control/application/application-controller";
import type { SessionController } from "../src/control/session/session-controller";
import { useApplicationStore } from "../src/control/state/application-store";
import type { BackendWebSocketClient } from "../src/control/transport/websocket-client";
import { isRequestTabDirty } from "../src/model/domain/application";

describe("ApplicationController request variable saves", () => {
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
});
