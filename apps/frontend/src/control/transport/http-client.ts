import type {
  AccessCredential,
  CurrentSession,
  Problem,
} from "@/model/contracts/backend";

/** Backend RFC 9457 response exposed as a typed frontend error. */
export class HttpProblemError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail);
    this.problem = problem;
  }
}

/**
 * Thin HTTP adapter for session lifecycle and blob operations.
 *
 * Domain workflows use the WebSocket control channel; HTTP remains responsible
 * for browser-cookie exchange and byte-oriented transfers.
 */
export class BackendHttpClient {
  /** Exchanges local-password input for access and refresh credentials. */
  async login(username: string, password: string): Promise<AccessCredential> {
    return this.#request<AccessCredential>("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        providerId: "local-password",
        fields: { username, password },
      }),
    });
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
    const response = await fetch("/auth/logout", {
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
    const response = await fetch(
      `/api/executions/${encodeURIComponent(executionId)}/body`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) {
      throw await this.#problem(response);
    }
    return response.blob();
  }

  /** Performs one JSON request and converts non-success responses to problems. */
  async #request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(path, init);
    if (!response.ok) {
      throw await this.#problem(response);
    }
    return (await response.json()) as T;
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
