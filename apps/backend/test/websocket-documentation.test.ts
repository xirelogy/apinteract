import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import type { Application } from "../src/bootstrap/application.js";
import type { BackendConfiguration } from "../src/config.js";
import { registerWebSocketRoute } from "../src/transport/websocket.js";

const USER_ID = "019facab-1eee-765f-bd9f-ac2449151ea1";
const SESSION_ID = "019facab-1eee-765f-bd9f-ac2449151ea2";
const WORKSPACE_ID = "019facab-1eee-765f-bd9f-ac2449151ea3";
const PUBLIC_ORIGIN = "http://localhost:8080";

interface CommandReply {
  readonly outcome: "success" | "error";
  readonly error?: { readonly code: string; readonly message: string };
}

const openSockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.terminate();
});

describe("WebSocket documentation validation", () => {
  it("defaults omitted resource documentation for older clients", async () => {
    const create = vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID });
    const { server, socket } = await authenticatedSocket({ create });

    try {
      const reply = await sendCommand(socket, "create", "workspace.create", {
        name: "Compatibility workspace",
      });

      expect(reply.outcome).toBe("success");
      expect(create).toHaveBeenCalledWith(
        USER_ID,
        "Compatibility workspace",
        "",
        "",
      );
    } finally {
      await server.close();
    }
  });

  it("forwards environment documentation through the command boundary", async () => {
    const create = vi.fn().mockResolvedValue({ environmentId: WORKSPACE_ID });
    const { server, socket } = await authenticatedSocket({}, { create });

    try {
      const reply = await sendCommand(socket, "create", "environment.create", {
        workspaceId: WORKSPACE_ID,
        name: "Development",
        description: "Development services",
        notes: "# Local environment",
        variables: [],
      });

      expect(reply.outcome).toBe("success");
      expect(create).toHaveBeenCalledWith(
        USER_ID,
        WORKSPACE_ID,
        "Development",
        [],
        undefined,
        "Development services",
        "# Local environment",
      );
    } finally {
      await server.close();
    }
  });

  it("rejects multiline and oversized resource documentation by UTF-8 bytes", async () => {
    const create = vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID });
    const { server, socket } = await authenticatedSocket({ create });

    try {
      const multiline = await sendCommand(
        socket,
        "multiline",
        "workspace.create",
        { name: "Invalid workspace", description: "First\nSecond" },
      );
      const oversizedDescription = await sendCommand(
        socket,
        "description",
        "workspace.create",
        { name: "Invalid workspace", description: "界".repeat(683) },
      );
      const oversizedNotes = await sendCommand(
        socket,
        "notes",
        "workspace.create",
        { name: "Invalid workspace", notes: "界".repeat(87_382) },
      );

      expect(multiline).toMatchObject({
        outcome: "error",
        error: { code: "validation_failed" },
      });
      expect(oversizedDescription).toMatchObject({
        outcome: "error",
        error: { code: "validation_failed" },
      });
      expect(oversizedNotes).toMatchObject({
        outcome: "error",
        error: { code: "validation_failed" },
      });
      expect(create).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects oversized nested field descriptions before domain dispatch", async () => {
    const update = vi.fn();
    const { server, socket } = await authenticatedSocket({ update });

    try {
      const reply = await sendCommand(socket, "update", "workspace.update", {
        workspaceId: WORKSPACE_ID,
        expectedRevision: 0,
        name: "Workspace",
        baseUrl: "",
        headers: [
          {
            name: "X-Test",
            value: "value",
            enabled: true,
            description: "界".repeat(1_366),
          },
        ],
      });

      expect(reply).toMatchObject({
        outcome: "error",
        error: { code: "validation_failed" },
      });
      expect(update).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

/** Creates one in-memory authenticated control socket around selected service spies. */
async function authenticatedSocket(
  workspaces: {
    readonly create?: ReturnType<typeof vi.fn>;
    readonly update?: ReturnType<typeof vi.fn>;
  },
  environments: { readonly create?: ReturnType<typeof vi.fn> } = {},
) {
  const server = Fastify();
  const application = {
    sessions: {
      authenticateAccessToken: vi.fn().mockResolvedValue({
        sessionId: SESSION_ID,
        user: {
          id: USER_ID,
          username: "tester",
          displayName: "Tester",
          isInstanceAdmin: false,
        },
        createdAt: 0,
        absoluteExpiresAt: Number.MAX_SAFE_INTEGER,
      }),
    },
    workspaces,
    environments,
  } as unknown as Application;
  const configuration = {
    server: { publicOrigin: PUBLIC_ORIGIN },
  } as BackendConfiguration;
  await registerWebSocketRoute(server, application, configuration);
  await server.ready();
  const socket = await server.injectWS("/ws", {
    headers: { origin: PUBLIC_ORIGIN },
  });
  openSockets.push(socket);
  const authentication = await sendCommand(
    socket,
    "authenticate",
    "session.authenticate",
    { accessToken: "access-token" },
  );
  expect(authentication.outcome).toBe("success");
  return { server, socket };
}

/** Sends one command and resolves only its correlated reply. */
function sendCommand(
  socket: WebSocket,
  id: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<CommandReply> {
  return new Promise((resolve) => {
    /** Ignores unrelated events and resolves the reply for this command. */
    const handleMessage = (data: Buffer): void => {
      const message = JSON.parse(data.toString()) as {
        readonly kind?: string;
        readonly commandId?: string;
      } & CommandReply;
      if (message.kind !== "reply" || message.commandId !== id) return;
      socket.off("message", handleMessage);
      resolve(message);
    };
    socket.on("message", handleMessage);
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        kind: "command",
        id,
        type,
        payload,
      }),
    );
  });
}
