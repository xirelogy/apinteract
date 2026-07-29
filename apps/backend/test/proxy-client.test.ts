import { afterEach, describe, expect, it, vi } from "vitest";

import { ProxyClient } from "../src/proxy/proxy-client.js";

describe("ProxyClient readiness", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts only the compatible ready proxy health contract", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "ready", apiVersion: "0.1.1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      new ProxyClient("http://127.0.0.1:8081/", "token").health(),
    ).resolves.toBe(true);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8081/health");
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects an incompatible proxy API version", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ status: "ready", apiVersion: "0.2.0" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );

    await expect(
      new ProxyClient("http://127.0.0.1:8081", "token").health(),
    ).resolves.toBe(false);
  });
});
