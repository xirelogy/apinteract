import type {
  CurrentSession,
  RequestAttachment,
} from "@/model/contracts/backend";
import { useApplicationStore } from "@/control/state/application-store";
import type { BackendHttpClient } from "@/control/transport/http-client";
import type { BackendWebSocketClient } from "@/control/transport/websocket-client";

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

  constructor(http: BackendHttpClient, webSocket: BackendWebSocketClient) {
    this.#http = http;
    this.#webSocket = webSocket;
  }

  /** Restores an access token or rotates the browser-managed refresh cookie. */
  async restore(): Promise<boolean> {
    const stored = sessionStorage.getItem(ACCESS_TOKEN_KEY);
    if (stored !== null) {
      try {
        const session = await this.#http.currentSession(stored);
        await this.#establish(stored, session);
        return true;
      } catch {
        sessionStorage.removeItem(ACCESS_TOKEN_KEY);
      }
    }
    // A missing or expired access token can be replaced without exposing the
    // refresh credential to JavaScript.
    try {
      const credential = await this.#http.refresh();
      await this.#establish(credential.accessToken, credential.session);
      return true;
    } catch {
      return false;
    }
  }

  /** Authenticates local credentials and establishes frontend session state. */
  async login(username: string, password: string): Promise<void> {
    const credential = await this.#http.login(username, password);
    await this.#establish(credential.accessToken, credential.session);
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
  }
}
