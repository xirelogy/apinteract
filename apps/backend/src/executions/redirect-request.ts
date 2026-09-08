import type { ExecutionRequestSnapshot } from "../requests/request-service.js";
import type { ScriptRequest } from "../scripting/script-types.js";
import type { ResolvedRedirectPolicy } from "./redirect-policy.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALWAYS_REGENERATED_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const CROSS_ORIGIN_CREDENTIAL_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);
const BODY_REPRESENTATION_HEADERS = new Set([
  "content-digest",
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
  "digest",
  "repr-digest",
]);

export interface RedirectResult {
  readonly location: string;
  readonly resolvedLocation?: {
    readonly value: string;
    readonly redacted: boolean;
  };
  readonly outcome: "followed" | "not_followed" | "failed";
  readonly reason?: string;
  readonly destinationExecutionId?: string;
  readonly removedHeaderNames: readonly string[];
}

export type RedirectDecision =
  | { readonly kind: "terminal"; readonly redirect?: RedirectResult }
  | {
      readonly kind: "follow";
      readonly request: ExecutionRequestSnapshot;
      readonly scriptRequest: ScriptRequest;
      readonly redirect: RedirectResult;
    }
  | {
      readonly kind: "error";
      readonly error: RedirectExecutionError;
      readonly redirect: RedirectResult;
    };

/** Stable redirect failure retained beside the source HTTP response. */
export class RedirectExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Decides whether and how one complete response produces another request. */
export function redirectDecision(
  status: number,
  responseHeaders: readonly { readonly name: string; readonly value: string }[],
  request: ExecutionRequestSnapshot,
  scriptRequest: ScriptRequest,
  policy: ResolvedRedirectPolicy,
  followedRedirects: number,
): RedirectDecision {
  if (!REDIRECT_STATUSES.has(status)) return { kind: "terminal" };
  const locations = responseHeaders.filter(
    (header) => header.name.toLowerCase() === "location",
  );
  if (locations.length === 0) return { kind: "terminal" };
  if (locations.length !== 1) {
    return redirectError(
      locations.map((header) => header.value).join("\n"),
      "redirect_invalid_location",
      "Redirect response contains multiple Location fields",
    );
  }
  const location = locations[0]!.value;
  let displayedTarget: URL;
  try {
    displayedTarget = new URL(location, request.targetUrl);
  } catch {
    return redirectError(
      location,
      "redirect_invalid_location",
      "Redirect Location is not a valid URL reference",
    );
  }
  const resolvedLocation = inspectableRedirectTarget(
    displayedTarget.toString(),
    scriptRequest.url.sensitive || !scriptRequest.url.readable,
  );
  const common = { location, resolvedLocation, removedHeaderNames: [] };
  if (displayedTarget.username !== "" || displayedTarget.password !== "") {
    return redirectError(
      location,
      "redirect_credentials_not_allowed",
      "Redirect Location must not contain credentials",
      resolvedLocation,
    );
  }
  if (
    displayedTarget.protocol !== "http:" &&
    displayedTarget.protocol !== "https:"
  ) {
    return redirectError(
      location,
      "redirect_unsupported_scheme",
      "Redirect Location must use HTTP or HTTPS",
      resolvedLocation,
    );
  }
  const source = new URL(request.targetUrl);
  if (source.protocol === "https:" && displayedTarget.protocol === "http:") {
    return redirectError(
      location,
      "redirect_insecure_downgrade",
      "Automatic redirects from HTTPS to HTTP are blocked",
      resolvedLocation,
    );
  }
  if (!policy.follow) {
    return {
      kind: "terminal",
      redirect: {
        ...common,
        outcome: "not_followed",
        reason: "redirect_disabled",
      },
    };
  }
  if (followedRedirects >= policy.maxRedirects) {
    return redirectError(
      location,
      "redirect_limit_exceeded",
      "Maximum redirect count was exceeded",
      resolvedLocation,
    );
  }

  displayedTarget.hash = "";
  const targetUrl = displayedTarget.toString();
  const sameOrigin = source.origin === displayedTarget.origin;
  const rewrite = redirectMethod(status, request.method);
  const connectionNamedHeaders = connectionHeaderNames(request.headers);
  const removedHeaderNames: string[] = [];
  const retainedHeaders: ExecutionRequestSnapshot["headers"][number][] = [];
  const retainedScriptHeaders: ScriptRequest["headers"][number][] = [];
  for (const [index, header] of request.headers.entries()) {
    const safe = scriptRequest.headers[index] ?? {
      name: header.name,
      value: header.value,
      readable: true,
      sensitive: false,
    };
    const name = header.name.toLowerCase();
    const remove =
      ALWAYS_REGENERATED_HEADERS.has(name) ||
      connectionNamedHeaders.has(name) ||
      (rewrite.dropBody && BODY_REPRESENTATION_HEADERS.has(name)) ||
      (!sameOrigin &&
        (CROSS_ORIGIN_CREDENTIAL_HEADERS.has(name) || safe.sensitive));
    if (remove) {
      if (!removedHeaderNames.includes(header.name)) {
        removedHeaderNames.push(header.name);
      }
      continue;
    }
    retainedHeaders.push(header);
    retainedScriptHeaders.push(safe);
  }
  const { bodyBytes, ...requestWithoutBodyBytes } = request;
  void bodyBytes;
  const nextRequest: ExecutionRequestSnapshot = {
    ...(rewrite.dropBody ? requestWithoutBodyBytes : request),
    method: rewrite.method,
    targetMode: "absolute",
    targetUrl,
    targetComponents: [targetUrl],
    query: [],
    headers: retainedHeaders,
    ...(rewrite.dropBody
      ? {
          body: "",
          bodyPresent: false,
          requestBody: { kind: "none" as const },
        }
      : {}),
  };
  const nextScriptRequest: ScriptRequest = {
    ...scriptRequest,
    method: rewrite.method,
    url: {
      readable: !scriptRequest.url.sensitive,
      sensitive: scriptRequest.url.sensitive,
      ...(scriptRequest.url.sensitive ? {} : { value: targetUrl }),
    },
    headers: retainedScriptHeaders,
    ...(rewrite.dropBody
      ? { body: { kind: "none", readable: true, sensitive: false } }
      : {}),
  };
  return {
    kind: "follow",
    request: nextRequest,
    scriptRequest: nextScriptRequest,
    redirect: {
      ...common,
      outcome: "followed",
      removedHeaderNames,
    },
  };
}

/** Selects the de-facto method/body behavior standardized for each status. */
function redirectMethod(
  status: number,
  method: ExecutionRequestSnapshot["method"],
): {
  readonly method: ExecutionRequestSnapshot["method"];
  readonly dropBody: boolean;
} {
  if (status === 303 && method !== "HEAD")
    return { method: "GET", dropBody: true };
  if ((status === 301 || status === 302) && method === "POST") {
    return { method: "GET", dropBody: true };
  }
  return { method, dropBody: false };
}

/** Extracts header tokens nominated by an outgoing Connection field. */
function connectionHeaderNames(
  headers: ExecutionRequestSnapshot["headers"],
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const header of headers) {
    if (header.enabled && header.name.toLowerCase() === "connection") {
      for (const token of header.value.split(",")) {
        if (token.trim() !== "") names.add(token.trim().toLowerCase());
      }
    }
  }
  return names;
}

/** Creates a secret-safe target displayed in redirect relationships. */
function inspectableRedirectTarget(
  target: string,
  redacted: boolean,
): { readonly value: string; readonly redacted: boolean } {
  return { value: redacted ? "[secret]" : target, redacted };
}

/** Builds one consistent failed redirect decision and source relationship. */
function redirectError(
  location: string,
  code: string,
  message: string,
  resolvedLocation?: { readonly value: string; readonly redacted: boolean },
): RedirectDecision {
  return {
    kind: "error",
    error: new RedirectExecutionError(code, message),
    redirect: {
      location,
      ...(resolvedLocation === undefined ? {} : { resolvedLocation }),
      outcome: "failed",
      reason: code,
      removedHeaderNames: [],
    },
  };
}
