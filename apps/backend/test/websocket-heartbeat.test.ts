import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { installWebSocketHeartbeat } from "../src/transport/websocket.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("WebSocket heartbeat", () => {
  it("pings healthy sockets and accepts their pong", () => {
    vi.useFakeTimers();
    const { socket, ping, terminate } = fakeSocket();
    const stop = installWebSocketHeartbeat(socket);

    vi.advanceTimersByTime(25_000);
    expect(ping).toHaveBeenCalledOnce();
    socket.emit("pong");
    vi.advanceTimersByTime(25_000);
    expect(ping).toHaveBeenCalledTimes(2);
    expect(terminate).not.toHaveBeenCalled();
    stop();
  });

  it("terminates a socket that misses the next pong", () => {
    vi.useFakeTimers();
    const { socket, ping, terminate } = fakeSocket();
    const stop = installWebSocketHeartbeat(socket);

    vi.advanceTimersByTime(50_000);
    expect(ping).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
    stop();
  });
});

/** Creates the minimal WebSocket surface required by the heartbeat watchdog. */
function fakeSocket(): {
  readonly socket: WebSocket & EventEmitter;
  readonly ping: ReturnType<typeof vi.fn>;
  readonly terminate: ReturnType<typeof vi.fn>;
} {
  const socket = new EventEmitter() as unknown as WebSocket & EventEmitter;
  const ping = vi.fn();
  const terminate = vi.fn();
  Object.assign(socket, {
    readyState: 1,
    OPEN: 1,
    ping,
    terminate,
  });
  return { socket, ping, terminate };
}
