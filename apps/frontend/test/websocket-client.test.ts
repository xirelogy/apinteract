import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BackendWebSocketClient,
  WebSocketCommandError,
} from "../src/control/transport/websocket-client";

type FakeEvent = Readonly<Record<string, unknown>>;
type FakeListener = (event: FakeEvent) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<FakeListener>>();
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  /** Registers a listener for one simulated WebSocket event type. */
  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.#listeners.get(type) ?? new Set<FakeListener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  /** Records one client message without performing network I/O. */
  send(data: string): void {
    this.sent.push(data);
  }

  /** Transitions the test socket to closed and emits its close event. */
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.#emit("close", {});
  }

  /** Transitions the test socket to open and emits its open event. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.#emit("open", {});
  }

  /** Delivers a JSON-encoded server message to registered listeners. */
  receive(value: unknown): void {
    this.#emit("message", { data: JSON.stringify(value) });
  }

  /** Synchronously invokes listeners for one simulated event. */
  #emit(type: string, event: FakeEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal("location", {
    protocol: "http:",
    host: "apinteract.test",
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BackendWebSocketClient", () => {
  it("correlates successful commands and delivers server events", async () => {
    const client = new BackendWebSocketClient();
    const connected = client.connect("access-token");
    const socket = requireSocket();
    socket.open();
    const authentication = await nextSentCommand(socket);
    socket.receive(successReply(authentication.id, { authenticated: true }));
    await connected;

    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));
    const resultPromise = client.command<{ workspaces: string[] }>(
      "workspace.list",
      {},
    );
    const command = await nextSentCommand(socket, 1);
    socket.receive(successReply(command.id, { workspaces: ["one"] }));
    socket.receive({
      protocolVersion: 1,
      kind: "event",
      type: "execution.progress",
      payload: { bodyBytes: 12 },
    });

    await expect(resultPromise).resolves.toEqual({ workspaces: ["one"] });
    expect(command).toMatchObject({
      protocolVersion: 1,
      kind: "command",
      type: "workspace.list",
      payload: {},
    });
    expect(command.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "execution.progress",
        payload: { bodyBytes: 12 },
      }),
    ]);
  });

  it("maps command failures and rejects pending work on close", async () => {
    const client = new BackendWebSocketClient();
    const connected = client.connect("access-token");
    const socket = requireSocket();
    socket.open();
    const authentication = await nextSentCommand(socket);
    socket.receive(successReply(authentication.id, {}));
    await connected;

    const rejected = client.command("workspace.create", { name: "" });
    const rejectedCommand = await nextSentCommand(socket, 1);
    socket.receive({
      protocolVersion: 1,
      kind: "reply",
      commandId: rejectedCommand.id,
      outcome: "error",
      error: {
        code: "validation_failed",
        message: "Name is required.",
      },
    });
    await expect(rejected).rejects.toEqual(
      new WebSocketCommandError("validation_failed", "Name is required."),
    );

    const pending = client.command("workspace.list", {});
    client.close();
    await expect(pending).rejects.toThrow("Backend connection closed");
  });
});

/** Returns the first socket created by the client under test. */
function requireSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances[0];
  if (socket === undefined) {
    throw new Error("Expected a WebSocket instance");
  }
  return socket;
}

/** Waits for and decodes a command sent at the requested test index. */
async function nextSentCommand(
  socket: FakeWebSocket,
  index = 0,
): Promise<{ readonly id: string; readonly type: string }> {
  await vi.waitFor(() => {
    expect(socket.sent.length).toBeGreaterThan(index);
  });
  const raw = socket.sent[index];
  if (raw === undefined) {
    throw new Error("Expected a sent command");
  }
  return JSON.parse(raw) as { readonly id: string; readonly type: string };
}

/** Builds a successful version 1 reply for a correlated command. */
function successReply(commandId: string, payload: unknown) {
  return {
    protocolVersion: 1,
    kind: "reply",
    commandId,
    outcome: "success",
    payload,
  };
}
