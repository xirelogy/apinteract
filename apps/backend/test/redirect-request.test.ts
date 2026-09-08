import { describe, expect, it } from "vitest";

import { redirectDecision } from "../src/executions/redirect-request.js";
import type { ExecutionRequestSnapshot } from "../src/requests/request-service.js";
import type { ScriptRequest } from "../src/scripting/script-types.js";

/** Creates one replayable materialized request for redirect matrix tests. */
function request(
  method: ExecutionRequestSnapshot["method"],
  targetUrl = "https://example.test/source?before=1",
): ExecutionRequestSnapshot {
  return {
    workspaceId: "019facab-1eee-765f-bd9f-ac2449151cf1",
    method,
    targetMode: "absolute",
    targetUrl,
    targetComponents: [targetUrl],
    query: [],
    headers: [
      { name: "Content-Type", value: "application/json", enabled: true },
    ],
    requestBody: { kind: "text", contentType: null, text: "payload" },
    body: "payload",
    bodyPresent: true,
    preRequestScript: "",
    postResponseScript: "",
  };
}

/** Creates the sensitivity-aware view aligned with the materialized request. */
function scriptRequest(
  value: ExecutionRequestSnapshot,
  sensitiveHeaderIndexes: readonly number[] = [],
): ScriptRequest {
  return {
    method: value.method,
    url: { value: value.targetUrl, readable: true, sensitive: false },
    headers: value.headers.map((header, index) => ({
      name: header.name,
      value: header.value,
      readable: !sensitiveHeaderIndexes.includes(index),
      sensitive: sensitiveHeaderIndexes.includes(index),
    })),
    body: {
      kind: "text",
      text: value.body,
      readable: true,
      sensitive: false,
    },
  };
}

/** Requires a redirect-follow result and narrows it for focused assertions. */
function followed(
  status: number,
  value: ExecutionRequestSnapshot,
  location = "/next",
) {
  const decision = redirectDecision(
    status,
    [{ name: "Location", value: location }],
    value,
    scriptRequest(value),
    { follow: true, maxRedirects: 10 },
    0,
  );
  expect(decision.kind).toBe("follow");
  if (decision.kind !== "follow") throw new Error("Expected redirect follow");
  return decision;
}

describe("redirect request construction", () => {
  it.each([
    [301, "GET", "GET", false],
    [301, "HEAD", "HEAD", false],
    [301, "POST", "GET", true],
    [301, "PUT", "PUT", false],
    [302, "POST", "GET", true],
    [303, "POST", "GET", true],
    [303, "HEAD", "HEAD", false],
    [303, "DELETE", "GET", true],
    [307, "POST", "POST", false],
    [308, "PATCH", "PATCH", false],
  ] as const)(
    "rewrites status %i method %s to %s",
    (status, originalMethod, nextMethod, dropsBody) => {
      const decision = followed(status, request(originalMethod));
      expect(decision.request.method).toBe(nextMethod);
      expect(decision.request.bodyPresent).toBe(!dropsBody);
      expect(decision.request.body).toBe(dropsBody ? "" : "payload");
      expect(
        decision.request.headers.some(
          (header) => header.name.toLowerCase() === "content-type",
        ),
      ).toBe(!dropsBody);
    },
  );

  it("resolves query references against the complete effective source URL", () => {
    const decision = followed(
      302,
      request("GET", "https://example.test/source?before=1"),
      "?after=2#display-only",
    );
    expect(decision.redirect.resolvedLocation?.value).toBe(
      "https://example.test/source?after=2#display-only",
    );
    expect(decision.request.targetUrl).toBe(
      "https://example.test/source?after=2",
    );
  });

  it("removes framing and body headers while recording names only", () => {
    const source = request("POST");
    const withHeaders: ExecutionRequestSnapshot = {
      ...source,
      headers: [
        ...source.headers,
        { name: "Content-Length", value: "7", enabled: true },
        { name: "Connection", value: "X-Hop", enabled: true },
        { name: "X-Hop", value: "private-hop", enabled: true },
        { name: "X-Retained", value: "ordinary", enabled: true },
      ],
    };
    const decision = redirectDecision(
      302,
      [{ name: "Location", value: "/next" }],
      withHeaders,
      scriptRequest(withHeaders),
      { follow: true, maxRedirects: 10 },
      0,
    );
    expect(decision.kind).toBe("follow");
    if (decision.kind !== "follow") return;
    expect(decision.request.headers.map((header) => header.name)).toEqual([
      "X-Retained",
    ]);
    expect(decision.redirect.removedHeaderNames).toEqual([
      "Content-Type",
      "Content-Length",
      "Connection",
      "X-Hop",
    ]);
  });

  it("retains same-origin credentials and strips every cross-origin credential", () => {
    const source: ExecutionRequestSnapshot = {
      ...request("GET"),
      headers: [
        { name: "Authorization", value: "Bearer public", enabled: true },
        { name: "Cookie", value: "session=value", enabled: true },
        { name: "X-Secret", value: "materialized", enabled: true },
        { name: "X-Ordinary", value: "safe", enabled: true },
      ],
    };
    const sameOrigin = redirectDecision(
      307,
      [{ name: "Location", value: "https://example.test/next" }],
      source,
      scriptRequest(source, [2]),
      { follow: true, maxRedirects: 10 },
      0,
    );
    expect(sameOrigin.kind).toBe("follow");
    if (sameOrigin.kind !== "follow") return;
    expect(sameOrigin.request.headers).toHaveLength(4);

    const crossOrigin = redirectDecision(
      307,
      [{ name: "Location", value: "https://other.test/next" }],
      source,
      scriptRequest(source, [2]),
      { follow: true, maxRedirects: 10 },
      0,
    );
    expect(crossOrigin.kind).toBe("follow");
    if (crossOrigin.kind !== "follow") return;
    expect(crossOrigin.request.headers.map((header) => header.name)).toEqual([
      "X-Ordinary",
    ]);
    expect(crossOrigin.redirect.removedHeaderNames).toEqual([
      "Authorization",
      "Cookie",
      "X-Secret",
    ]);
  });

  it.each([
    ["https://example.test/next", "redirect_disabled", false, 10, 0],
    ["https://example.test/next", "redirect_limit_exceeded", true, 1, 1],
    ["http://example.test/next", "redirect_insecure_downgrade", true, 10, 0],
    ["ftp://example.test/next", "redirect_unsupported_scheme", true, 10, 0],
    [
      "https://name:secret@example.test/next",
      "redirect_credentials_not_allowed",
      true,
      10,
      0,
    ],
  ] as const)(
    "stops %s with %s",
    (location, reason, follow, maxRedirects, count) => {
      const source = request("GET");
      const decision = redirectDecision(
        302,
        [{ name: "Location", value: location }],
        source,
        scriptRequest(source),
        { follow, maxRedirects },
        count,
      );
      expect(decision.kind).not.toBe("follow");
      expect(decision.redirect?.reason).toBe(reason);
    },
  );

  it("rejects ambiguous Location fields and ignores non-redirect statuses", () => {
    const source = request("GET");
    const ambiguous = redirectDecision(
      302,
      [
        { name: "Location", value: "/one" },
        { name: "location", value: "/two" },
      ],
      source,
      scriptRequest(source),
      { follow: true, maxRedirects: 10 },
      0,
    );
    expect(ambiguous.kind).toBe("error");
    expect(ambiguous.redirect?.reason).toBe("redirect_invalid_location");
    expect(
      redirectDecision(
        300,
        [{ name: "Location", value: "/next" }],
        source,
        scriptRequest(source),
        { follow: true, maxRedirects: 10 },
        0,
      ),
    ).toEqual({ kind: "terminal" });
  });
});
