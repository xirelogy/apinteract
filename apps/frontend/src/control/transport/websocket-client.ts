import { v7 as uuidV7 } from "uuid";

interface SuccessReply {
  readonly protocolVersion: 1;
  readonly kind: "reply";
  readonly commandId: string;
  readonly outcome: "success";
  readonly payload: unknown;
}

interface ErrorReply {
  readonly protocolVersion: 1;
  readonly kind: "reply";
  readonly commandId: string;
  readonly outcome: "error";
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

interface EventMessage {
  readonly protocolVersion: 1;
  readonly kind: "event";
  readonly type: string;
  readonly payload: unknown;
}

type IncomingMessage = SuccessReply | ErrorReply | EventMessage;

interface PendingCommand {
  readonly resolve: (payload: unknown) => void;
  readonly reject: (cause: Error) => void;
}

export class WebSocketCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Correlates frontend commands with replies on one backend control connection.
 *
 * Connection authentication is the first command after the socket opens.
 * Outstanding commands are rejected when the connection closes so controllers
 * cannot remain indefinitely busy waiting for replies that will never arrive.
 */
export class BackendWebSocketClient {
  readonly #pending = new Map<string, PendingCommand>();
  readonly #eventListeners = new Set<(event: EventMessage) => void>();
  #socket: WebSocket | null = null;

  /** Opens and authenticates a fresh backend control connection. */
  async connect(accessToken: string): Promise<void> {
    this.close();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Could not connect to the backend")),
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => this.#receive(event.data));
    socket.addEventListener("close", () => this.#rejectPending());
    // Domain commands are not valid until this command establishes connection
    // ownership on the backend.
    await this.command("session.authenticate", { accessToken });
  }

  /** Replaces an expiring token without changing connection ownership. */
  async reauthenticate(accessToken: string): Promise<void> {
    await this.command("session.authenticate", { accessToken });
  }

  /** Sends one correlated command and resolves it from the matching reply. */
  command<T>(
    type: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Backend connection is not open"));
    }
    const id = uuidV7();
    // Register before send so even an immediate reply can resolve its command.
    const result = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        kind: "command",
        id,
        type,
        payload,
      }),
    );
    return result;
  }

  /** Registers an event listener and returns its removal function. */
  onEvent(listener: (event: EventMessage) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** Closes the socket and rejects every outstanding command. */
  close(): void {
    this.#socket?.close();
    this.#socket = null;
    this.#rejectPending();
  }

  /** Routes one decoded server message to listeners or its pending command. */
  #receive(raw: unknown): void {
    if (typeof raw !== "string") {
      return;
    }
    const message = JSON.parse(raw) as IncomingMessage;
    if (message.kind === "event") {
      for (const listener of this.#eventListeners) {
        listener(message);
      }
      return;
    }
    const pending = this.#pending.get(message.commandId);
    if (pending === undefined) {
      // Late replies for commands rejected during close are intentionally
      // ignored; they cannot be associated with current controller state.
      return;
    }
    this.#pending.delete(message.commandId);
    if (message.outcome === "success") {
      pending.resolve(message.payload);
    } else {
      pending.reject(
        new WebSocketCommandError(message.error.code, message.error.message),
      );
    }
  }

  /** Rejects and removes all commands waiting on the current connection. */
  #rejectPending(): void {
    for (const pending of this.#pending.values()) {
      pending.reject(new Error("Backend connection closed"));
    }
    this.#pending.clear();
  }
}
