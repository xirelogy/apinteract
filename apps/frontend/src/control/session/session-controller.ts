import type {
  BackendHealth,
  CurrentSession,
  RequestAttachment,
} from "@/model/contracts/backend";
import { useApplicationStore } from "@/control/state/application-store";
import {
  BackendUnavailableError,
  type BackendHttpClient,
  HttpProblemError,
} from "@/control/transport/http-client";
import {
  BackendConnectionError,
  type BackendWebSocketClient,
} from "@/control/transport/websocket-client";

const ACCESS_TOKEN_KEY = "apinteract.access-token";

/**
 * Coordinates browser session restoration with the backend control channel.
 *
 * The short-lived access token is retained in session storage. The rotating
 * refresh credential remains an opaque HttpOnly cookie managed by the browser
 * and the non-pluggable backend session service.
 */
export class SessionController {
  readonly #http: BackendHttpClient;
  readonly #webSocket: BackendWebSocketClient;
  #accessToken: string | null = null;
  #recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  #recoveryAttempt = 0;
  #stopNetworkRecovery: (() => void) | null = null;
  readonly #authenticationLostListeners = new Set<() => void>();

  constructor(http: BackendHttpClient, webSocket: BackendWebSocketClient) {
    this.#http = http;
    this.#webSocket = webSocket;
    this.#webSocket.onDisconnect(() => this.#connectionLost());
  }

  /** Restores an access token or rotates the browser-managed refresh cookie. */
  async restore(): Promise<boolean> {
    const stored = sessionStorage.getItem(ACCESS_TOKEN_KEY);
    if (stored !== null) {
      try {
        const session = await this.#http.currentSession(stored);
        await this.#establish(stored, session);
        return true;
      } catch (cause) {
        if (isBackendUnavailable(cause)) {
          this.#markUnavailable();
          return false;
        }
        if (isUnauthorized(cause)) {
          sessionStorage.removeItem(ACCESS_TOKEN_KEY);
        } else {
          useApplicationStore().connection = "disconnected";
          return false;
        }
      }
    }
    // A missing or expired access token can be replaced without exposing the
    // refresh credential to JavaScript.
    try {
      const credential = await this.#http.refresh();
      await this.#establish(credential.accessToken, credential.session);
      return true;
    } catch (cause) {
      if (isBackendUnavailable(cause)) this.#markUnavailable();
      else useApplicationStore().connection = "disconnected";
      return false;
    }
  }

  /** Starts browser online/offline recovery and returns its cleanup function. */
  startNetworkRecovery(): () => void {
    if (this.#stopNetworkRecovery !== null) return this.#stopNetworkRecovery;
    /** Retries immediately when the browser reports restored connectivity. */
    const handleOnline = () => this.#scheduleRecovery(0);
    /** Hides authenticated presentation as soon as the browser goes offline. */
    const handleOffline = () => {
      this.#webSocket.close();
      useApplicationStore().connection = "offline";
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    /** Removes browser listeners and cancels a scheduled recovery attempt. */
    const stop = () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      if (this.#recoveryTimer !== null) clearTimeout(this.#recoveryTimer);
      this.#recoveryTimer = null;
      this.#stopNetworkRecovery = null;
    };
    this.#stopNetworkRecovery = stop;
    if (
      (useApplicationStore().connection === "offline" ||
        useApplicationStore().connection === "reconnecting") &&
      navigator.onLine
    ) {
      this.#scheduleRecovery(0);
    }
    return stop;
  }

  /** Registers for confirmed session-expiry notifications during recovery. */
  onAuthenticationLost(listener: () => void): () => void {
    this.#authenticationLostListeners.add(listener);
    return () => this.#authenticationLostListeners.delete(listener);
  }

  /** Authenticates local credentials and establishes frontend session state. */
  async login(username: string, password: string): Promise<void> {
    const credential = await this.#http.login(username, password);
    await this.#establish(credential.accessToken, credential.session);
  }

  /** Loads backend and proxy product versions through the HTTP health endpoint. */
  async health(): Promise<BackendHealth> {
    return this.#http.health();
  }

  /** Revokes the backend session and clears all local authenticated state. */
  async logout(): Promise<void> {
    if (this.#accessToken !== null) {
      await this.#http.logout(this.#accessToken);
    }
    this.#accessToken = null;
    sessionStorage.removeItem(ACCESS_TOKEN_KEY);
    this.#webSocket.close();
    const store = useApplicationStore();
    store.$reset();
  }

  /** Downloads response bytes using the active session's bearer credential. */
  async downloadExecutionBody(executionId: string): Promise<Blob> {
    if (this.#accessToken === null) {
      throw new Error("An authenticated session is required");
    }
    return this.#http.downloadExecutionBody(this.#accessToken, executionId);
  }

  /** Uploads one multipart file through the active bearer-authenticated session. */
  async uploadRequestAttachment(
    workspaceId: string,
    file: File,
  ): Promise<RequestAttachment> {
    if (this.#accessToken === null) {
      throw new Error("An authenticated session is required");
    }
    return this.#http.uploadRequestAttachment(
      this.#accessToken,
      workspaceId,
      file,
    );
  }

  /** Connects the control channel before publishing authenticated view state. */
  async #establish(
    accessToken: string,
    session: CurrentSession,
  ): Promise<void> {
    const store = useApplicationStore();
    store.connection = "connecting";
    await this.#webSocket.connect(accessToken);
    this.#accessToken = accessToken;
    sessionStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    store.session = session;
    store.connection = "authenticated";
    this.#recoveryAttempt = 0;
  }

  /** Moves authenticated presentation behind the neutral recovery screen. */
  #connectionLost(): void {
    this.#markUnavailable();
    this.#scheduleRecovery();
  }

  /** Records the browser/backend availability state without clearing credentials. */
  #markUnavailable(): void {
    useApplicationStore().connection = navigator.onLine
      ? "reconnecting"
      : "offline";
  }

  /** Schedules bounded exponential retries through the normal restore path. */
  #scheduleRecovery(delay?: number): void {
    if (this.#recoveryTimer !== null) return;
    const wait =
      delay ?? Math.min(30_000, 500 * Math.pow(2, this.#recoveryAttempt++));
    this.#recoveryTimer = setTimeout(() => {
      this.#recoveryTimer = null;
      void this.#recover();
    }, wait);
  }

  /** Revalidates HTTP identity and WebSocket authentication after a disconnect. */
  async #recover(): Promise<void> {
    if (!navigator.onLine) {
      useApplicationStore().connection = "offline";
      return;
    }
    useApplicationStore().connection = "reconnecting";
    const restored = await this.restore();
    if (!restored) {
      if (useApplicationStore().connection === "reconnecting") {
        this.#scheduleRecovery();
      } else {
        this.#accessToken = null;
        sessionStorage.removeItem(ACCESS_TOKEN_KEY);
        this.#webSocket.close();
        useApplicationStore().$reset();
        for (const listener of this.#authenticationLostListeners) listener();
      }
    }
  }
}

/** Reports whether a failed transport attempt produced no backend response. */
function isBackendUnavailable(cause: unknown): boolean {
  return (
    cause instanceof BackendUnavailableError ||
    cause instanceof BackendConnectionError ||
    (cause instanceof HttpProblemError && cause.problem.status >= 500)
  );
}

/** Reports whether the backend explicitly rejected the stored bearer token. */
function isUnauthorized(cause: unknown): boolean {
  return cause instanceof HttpProblemError && cause.problem.status === 401;
}
