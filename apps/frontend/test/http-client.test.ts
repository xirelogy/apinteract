import { afterEach, describe, expect, it, vi } from "vitest";

import { BackendHttpClient } from "../src/control/transport/http-client";

describe("BackendHttpClient response-body download", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("authorizes and returns exact response bytes", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0, 1, 2, 255]), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const body = await new BackendHttpClient().downloadExecutionBody(
      "access-token",
      "execution/id",
    );

    expect(fetch).toHaveBeenCalledWith("/api/executions/execution%2Fid/body", {
      headers: { Authorization: "Bearer access-token" },
    });
    expect([...new Uint8Array(await body.arrayBuffer())]).toEqual([
      0, 1, 2, 255,
    ]);
  });

  it("maps a denied download to the backend problem contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: "/problems/execution_body_not_found",
            title: "Execution body not found",
            status: 404,
            code: "execution_body_not_found",
            detail: "The response body does not exist or is not visible.",
            correlationId: "00000000-0000-7000-8000-000000000000",
            errors: [],
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/problem+json" },
          },
        ),
      ),
    );

    await expect(
      new BackendHttpClient().downloadExecutionBody("access-token", "missing"),
    ).rejects.toMatchObject({
      problem: { code: "execution_body_not_found" },
    });
  });
});
