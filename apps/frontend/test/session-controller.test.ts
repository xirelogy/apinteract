// @vitest-environment jsdom

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionController } from "../src/control/session/session-controller";
import { useApplicationStore } from "../src/control/state/application-store";
import type { BackendHttpClient } from "../src/control/transport/http-client";
import {
  BackendUnavailableError,
  HttpProblemError,
} from "../src/control/transport/http-client";
import type { BackendWebSocketClient } from "../src/control/transport/websocket-client";

const accessTokenKey = "apinteract.access-token";

beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SessionController restoration", () => {
  it("preserves a stored credential when the backend is unavailable", async () => {
    sessionStorage.setItem(accessTokenKey, "stored-token");
    const refresh = vi.fn();
    const http = {
      currentSession: vi
        .fn()
        .mockRejectedValue(new BackendUnavailableError("offline")),
      refresh,
    } as unknown as BackendHttpClient;
    const webSocket = createWebSocket();
    const session = new SessionController(http, webSocket.client);

    await expect(session.restore()).resolves.toBe(false);

    expect(sessionStorage.getItem(accessTokenKey)).toBe("stored-token");
    expect(refresh).not.toHaveBeenCalled();
    expect(useApplicationStore().connection).toBe("reconnecting");
  });

  it("replaces an explicitly rejected token through the refresh path", async () => {
    const currentSession = {
      user: { userId: "user-id", username: "alice" },
    };
    sessionStorage.setItem(accessTokenKey, "expired-token");
    const http = {
      currentSession: vi.fn().mockRejectedValue(
        new HttpProblemError({
          type: "/problems/unauthorized",
          title: "Unauthorized",
          status: 401,
          code: "unauthorized",
          detail: "Authentication is required.",
          correlationId: "00000000-0000-7000-8000-000000000000",
          errors: [],
        }),
      ),
      refresh: vi.fn().mockResolvedValue({
        accessToken: "replacement-token",
        session: currentSession,
      }),
    } as unknown as BackendHttpClient;
    const webSocket = createWebSocket();
    const session = new SessionController(http, webSocket.client);

    await expect(session.restore()).resolves.toBe(true);

    expect(webSocket.connect).toHaveBeenCalledWith("replacement-token");
    expect(sessionStorage.getItem(accessTokenKey)).toBe("replacement-token");
    expect(useApplicationStore().session).toEqual(currentSession);
    expect(useApplicationStore().connection).toBe("authenticated");
  });
});

/** Creates the control-channel surface required by the session controller. */
function createWebSocket(): {
  readonly client: BackendWebSocketClient;
  readonly connect: ReturnType<typeof vi.fn>;
} {
  const connect = vi.fn().mockResolvedValue(undefined);
  return {
    client: {
      connect,
      close: vi.fn(),
      onDisconnect: vi.fn().mockReturnValue(() => undefined),
    } as unknown as BackendWebSocketClient,
    connect,
  };
}
