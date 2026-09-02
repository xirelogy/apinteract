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

  it("returns the proxy protocol version with readiness details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "ready",
            apiVersion: "0.1.1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(
      new ProxyClient("http://127.0.0.1:8081", "token").healthDetails(),
    ).resolves.toEqual({
      ready: true,
      protocolVersion: "0.1.1",
    });
  });

  it("uploads a present empty body with a zero-length stream descriptor", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ executionId: "proxy-execution" }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      new ProxyClient("http://127.0.0.1:8081", "token").execute(
        "request-body-empty",
        "POST",
        "https://example.test/empty",
        [],
        Buffer.alloc(0),
        {
          responseHead: () => Promise.resolve(),
          body: () => Promise.resolve(),
          complete: () => Promise.resolve(),
        },
        true,
      ),
    ).rejects.toThrow("Proxy response stream failed with 500");

    const creationBody = fetch.mock.calls[0]?.[1]?.body;
    if (typeof creationBody !== "string") {
      throw new Error("Expected a serialized proxy execution request");
    }
    const creation = JSON.parse(creationBody) as {
      request: { body: unknown };
    };
    expect(creation.request.body).toEqual({
      mode: "stream",
      length: 0,
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "http://127.0.0.1:8081/executions/proxy-execution/request-body",
    );
    expect(fetch.mock.calls[1]?.[1]?.body).toBeInstanceOf(Uint8Array);
    expect((fetch.mock.calls[1]?.[1]?.body as Uint8Array).byteLength).toBe(0);
  });

  it("does not upload an absent body", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ executionId: "proxy-execution" }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      new ProxyClient("http://127.0.0.1:8081", "token").execute(
        "request-body-none",
        "POST",
        "https://example.test/none",
        [],
        Buffer.alloc(0),
        {
          responseHead: () => Promise.resolve(),
          body: () => Promise.resolve(),
          complete: () => Promise.resolve(),
        },
        false,
      ),
    ).rejects.toThrow("Proxy response stream failed with 500");

    const creationBody = fetch.mock.calls[0]?.[1]?.body;
    if (typeof creationBody !== "string") {
      throw new Error("Expected a serialized proxy execution request");
    }
    const creation = JSON.parse(creationBody) as {
      request: { body: unknown };
    };
    expect(creation.request.body).toEqual({
      mode: "none",
      length: 0,
      sha256: null,
    });
    expect(fetch.mock.calls).toHaveLength(3);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "http://127.0.0.1:8081/executions/proxy-execution/response",
    );
  });

  it("uploads opaque request bytes without UTF-8 conversion", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ executionId: "proxy-execution" }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const bytes = Buffer.from([0, 127, 128, 255]);

    await expect(
      new ProxyClient("http://127.0.0.1:8081", "token").execute(
        "request-body-binary",
        "POST",
        "https://example.test/binary",
        [],
        bytes,
        {
          responseHead: () => Promise.resolve(),
          body: () => Promise.resolve(),
          complete: () => Promise.resolve(),
        },
        true,
      ),
    ).rejects.toThrow("Proxy response stream failed with 500");

    const uploaded = fetch.mock.calls[1]?.[1]?.body;
    expect(uploaded).toBeInstanceOf(Uint8Array);
    expect([...((uploaded as Uint8Array | undefined) ?? [])]).toEqual([
      0, 127, 128, 255,
    ]);
  });
});
