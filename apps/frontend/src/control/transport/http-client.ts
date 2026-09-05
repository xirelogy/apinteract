import type {
  AccessCredential,
  BackendHealth,
  CurrentSession,
  Problem,
  RequestAttachment,
  WebBootstrapRequest,
  WebBootstrapStatus,
} from "@/model/contracts/backend";
import type {
  AuthProviderPublicDescriptor,
  AuthProviderValue,
} from "@apinteract/plugin-api/backend/authentication";
import type { AuthProviderPluginPackageManifest } from "@apinteract/plugin-api";

export interface AuthProviderCatalogEntry {
  readonly manifest: AuthProviderPluginPackageManifest;
  readonly descriptor: AuthProviderPublicDescriptor;
  readonly moduleUrl: string;
}

export type AuthAttemptResult =
  | { readonly status: "authenticated"; readonly credential: AccessCredential }
  | {
      readonly status: "interaction_required";
      readonly attemptId: string;
      readonly publicData: AuthProviderValue;
    };

/** Backend RFC 9457 response exposed as a typed frontend error. */
export class HttpProblemError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail);
    this.problem = problem;
  }
}

/** Indicates that no HTTP response could be obtained from the backend. */
export class BackendUnavailableError extends Error {}

/**
 * Thin HTTP adapter for session lifecycle and blob operations.
 *
 * Domain workflows use the WebSocket control channel; HTTP remains responsible
 * for browser-cookie exchange and byte-oriented transfers.
 */
export class BackendHttpClient {
  /** Reads authoritative first-user web setup availability. */
  async webBootstrapStatus(): Promise<WebBootstrapStatus> {
    return this.#request<WebBootstrapStatus>("/auth/bootstrap", {});
  }

  /** Creates the first administrator without establishing a browser session. */
  async initializeFirstAdministrator(
    input: WebBootstrapRequest,
  ): Promise<void> {
    await this.#request<void>("/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  /** Reads backend and proxy readiness metadata for the options view. */
  async health(): Promise<BackendHealth> {
    const response = await this.#fetch("/health", {});
    const health = (await response.json()) as BackendHealth;
    if (!response.ok && response.status < 500) {
      throw await this.#problem(response);
    }
    return health;
  }

  /** Lists configured authentication instances and their safe built-in modules. */
  async authProviders(): Promise<readonly AuthProviderCatalogEntry[]> {
    const result = await this.#request<{
      providers: AuthProviderCatalogEntry[];
    }>("/auth/providers", {});
    return result.providers;
  }

  /** Starts one provider-independent authentication attempt. */
  async beginAuthentication(
    providerId: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<AuthAttemptResult> {
    return this.#request<AuthAttemptResult>("/auth/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        providerId,
        fields,
      }),
    });
  }

  /** Continues the current browser-bound authentication attempt. */
  async continueAuthentication(
    attemptId: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<AuthAttemptResult> {
    return this.#request<AuthAttemptResult>(
      `/auth/attempts/${encodeURIComponent(attemptId)}/continue`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ fields }),
      },
    );
  }

  /** Cancels the current authentication attempt and its browser binding. */
  async cancelAuthentication(attemptId: string): Promise<void> {
    await this.#request<void>(
      `/auth/attempts/${encodeURIComponent(attemptId)}`,
      { method: "DELETE", credentials: "include" },
    );
  }

  /** Rotates the HttpOnly refresh cookie and returns a new access token. */
  async refresh(): Promise<AccessCredential> {
    return this.#request<AccessCredential>("/auth/refresh", {
      method: "POST",
      credentials: "include",
    });
  }

  /** Resolves current session identity from a bearer access token. */
  async currentSession(accessToken: string): Promise<CurrentSession> {
    return this.#request<CurrentSession>("/auth/session", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  /** Revokes a bearer session while accepting an already-invalid token. */
  async logout(accessToken: string): Promise<void> {
    const response = await this.#fetch("/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok && response.status !== 401) {
      throw await this.#problem(response);
    }
  }

  /** Downloads exact authorized response bytes for one visible execution. */
  async downloadExecutionBody(
    accessToken: string,
    executionId: string,
  ): Promise<Blob> {
    const response = await this.#fetch(
      `/api/executions/${encodeURIComponent(executionId)}/body`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) {
      throw await this.#problem(response);
    }
    return response.blob();
  }

  /** Uploads exact file bytes and returns their immutable workspace metadata. */
  async uploadRequestAttachment(
    accessToken: string,
    workspaceId: string,
    file: File,
  ): Promise<RequestAttachment> {
    return this.#request<RequestAttachment>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/request-attachments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/octet-stream",
          "X-APInteract-File-Name": encodeURIComponent(file.name),
          "X-APInteract-File-Type": encodeURIComponent(
            file.type || "application/octet-stream",
          ),
        },
        body: file,
      },
    );
  }

  /** Performs one JSON request and converts non-success responses to problems. */
  async #request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.#fetch(path, init);
    if (!response.ok) {
      throw await this.#problem(response);
    }
    return response.status === 204
      ? (undefined as T)
      : ((await response.json()) as T);
  }

  /** Performs a browser request while preserving network failures as a typed state. */
  async #fetch(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(path, init);
    } catch (cause) {
      throw new BackendUnavailableError(
        "The APInteract backend is unavailable.",
        { cause },
      );
    }
  }

  /** Parses a problem response or constructs a safe fallback problem. */
  async #problem(response: Response): Promise<HttpProblemError> {
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/problem+json") === true) {
      return new HttpProblemError((await response.json()) as Problem);
    }
    return new HttpProblemError({
      type: "/problems/unexpected_response",
      title: "Unexpected backend response",
      status: response.status,
      code: "unexpected_response",
      detail: `The backend returned HTTP ${response.status}.`,
      correlationId: "00000000-0000-7000-8000-000000000000",
      errors: [],
    });
  }
}
