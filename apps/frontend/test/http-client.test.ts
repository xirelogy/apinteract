import { afterEach, describe, expect, it, vi } from "vitest";

import { BackendHttpClient } from "../src/control/transport/http-client";

describe("BackendHttpClient byte transfers", () => {
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

  it("uploads exact attachment bytes with percent-encoded metadata", async () => {
    const attachment = {
      attachmentId: "019facab-1eee-765f-bd9f-ac2449151da1",
      workspaceId: "019facab-1eee-765f-bd9f-ac2449151da2",
      fileName: "示例 data.bin",
      contentType: "application/octet-stream",
      byteLength: 4,
      sha256: "b".repeat(64),
    };
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(attachment), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const file = new File(
      [new Uint8Array([0, 1, 2, 255])],
      attachment.fileName,
      {
        type: attachment.contentType,
      },
    );

    await expect(
      new BackendHttpClient().uploadRequestAttachment(
        "access-token",
        "workspace/id",
        file,
      ),
    ).resolves.toEqual(attachment);
    expect(fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace%2Fid/request-attachments",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer access-token",
          "Content-Type": "application/octet-stream",
          "X-APInteract-File-Name": encodeURIComponent(attachment.fileName),
          "X-APInteract-File-Type": encodeURIComponent(attachment.contentType),
        },
        body: file,
      },
    );
  });
});
