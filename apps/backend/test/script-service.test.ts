import { afterEach, describe, expect, it } from "vitest";

import { ScriptService } from "../src/scripting/script-service.js";
import type {
  PostResponseScriptInput,
  PreRequestScriptInput,
} from "../src/scripting/script-types.js";

const baseRequest = {
  method: "GET",
  url: {
    value: "https://example.test/items",
    readable: true,
    sensitive: false,
  },
  headers: [
    {
      name: "Accept",
      value: "application/json",
      readable: true,
      sensitive: false,
    },
  ],
  body: { kind: "none", readable: true, sensitive: false } as const,
};

const variables = [
  {
    name: "customerId",
    status: "resolved" as const,
    declaredKind: "value" as const,
    effectiveKind: "value" as const,
    sensitive: false,
    sourceScope: "workspace" as const,
    value: "customer-42",
  },
  {
    name: "accessToken",
    status: "resolved" as const,
    declaredKind: "secret" as const,
    effectiveKind: "secret" as const,
    sensitive: true,
    sourceScope: "environment" as const,
  },
];

/** Creates one safe pre-request fixture. */
function preInput(): PreRequestScriptInput {
  return {
    execution: { id: "execution-1", startedAt: "2026-08-10T00:00:00.000Z" },
    request: baseRequest,
    variables,
  };
}

/** Creates one complete post-response fixture. */
function postInput(): PostResponseScriptInput {
  return {
    ...preInput(),
    response: {
      status: 201,
      headers: [
        {
          name: "Content-Type",
          value: "application/json",
          readable: true,
          sensitive: false,
        },
      ],
      body: {
        size: 14,
        sha256: "digest",
        available: true,
        bytes: new TextEncoder().encode('{"id":"item-1"}'),
      },
    },
  };
}

describe("ScriptService", () => {
  let service: ScriptService;

  afterEach(async () => {
    await service.close();
  });

  it("runs a pre-request script with safe variable and request access", async () => {
    service = new ScriptService();

    const result = await service.runPreRequest(
      `
        const id = asdk.variables.require("customerId");
        asdk.request.setMethod("POST");
        asdk.request.setUrl("https://example.test/customers/" + id);
        asdk.request.headers.set("X-Customer-Id", id);
        asdk.request.headers.set(
          "Authorization",
          "Bearer " + asdk.variables.reference("accessToken"),
        );
        asdk.request.body.setText(JSON.stringify({ id }));
        asdk.local.set("started", asdk.time.now());
        asdk.log.info("prepared", { phase: asdk.phase });
      `,
      preInput(),
    );

    expect(result.request.headers).toEqual([
      ...baseRequest.headers,
      {
        name: "X-Customer-Id",
        value: "customer-42",
        readable: true,
        sensitive: false,
      },
      {
        name: "Authorization",
        value: "Bearer <<accessToken>>",
        readable: true,
        sensitive: true,
      },
    ]);
    expect(result.request.method).toBe("POST");
    expect(result.request.url.value).toBe(
      "https://example.test/customers/customer-42",
    );
    expect(result.request.body).toEqual({
      kind: "text",
      text: '{"id":"customer-42"}',
      readable: true,
      sensitive: false,
    });
    expect(result.local).toEqual({ started: "2026-08-10T00:00:00.000Z" });
    expect(result.logs).toEqual([
      {
        sequence: 1,
        level: "info",
        message: "prepared",
        fields: { phase: "pre-request" },
      },
    ]);
  });

  it("does not expose secret values and supports post-response tests", async () => {
    service = new ScriptService();

    await expect(
      service.runPreRequest(
        'asdk.variables.require("accessToken");',
        preInput(),
      ),
    ).rejects.toMatchObject({
      code: "sensitive_value_unavailable",
    });

    const result = await service.runPostResponse(
      `
        asdk.test("created", () => {
          asdk.assert.equal(asdk.response.status, 201);
          asdk.assert.ok(asdk.response.body.text().includes("item-1"));
          asdk.assert.deepEqual(JSON.parse(asdk.response.body.text()), { id: "item-1" });
          asdk.assert.match(asdk.response.body.text(), /item-\\d/);
        });
        asdk.local.set("result", "ok");
      `,
      postInput(),
    );

    expect(result.tests).toEqual([
      { sequence: 1, name: "created", status: "passed" },
    ]);
    expect(result.local).toEqual({ result: "ok" });
  });

  it("does not provide ambient host capabilities", async () => {
    service = new ScriptService();

    const result = await service.runPreRequest(
      `
        asdk.local.set(
          "capabilities",
          [
            typeof fetch,
            typeof process,
            typeof require,
            typeof Date,
            typeof setTimeout,
            typeof (() => {}).constructor,
          ].join(","),
        );
      `,
      preInput(),
    );

    expect(result.local).toEqual({
      capabilities:
        "undefined,undefined,undefined,undefined,undefined,undefined",
    });
  });

  it("redacts secret-derived request fields from post-response scripts", async () => {
    service = new ScriptService();
    const input = postInput();

    const result = await service.runPostResponse(
      `
        for (const [name, read] of [
          ["url", () => asdk.request.url.get()],
          ["header", () => asdk.request.headers.get("Authorization")],
          ["body", () => asdk.request.body.text()],
        ]) {
          try {
            read();
            asdk.local.set(name, "exposed");
          } catch (error) {
            asdk.local.set(name, error.name);
          }
        }
      `,
      {
        ...input,
        request: {
          ...input.request,
          url: {
            value: "https://secret.test",
            readable: true,
            sensitive: true,
          },
          headers: [
            {
              name: "Authorization",
              value: "Bearer plaintext-secret",
              readable: true,
              sensitive: true,
            },
          ],
          body: {
            kind: "text",
            text: "plaintext-secret",
            readable: true,
            sensitive: true,
          },
        },
      },
    );

    expect(result.local).toEqual({
      url: "AsdkError",
      header: "AsdkError",
      body: "AsdkError",
    });
  });

  it("supports binary encodings and isolates globals between invocations", async () => {
    service = new ScriptService();

    const first = await service.runPreRequest(
      `
        globalThis.invocationLeak = "present";
        const bytes = asdk.encoding.utf8Encode("hello");
        asdk.request.body.setBytes(asdk.encoding.base64Decode(asdk.encoding.base64Encode(bytes)));
      `,
      preInput(),
    );
    const second = await service.runPreRequest(
      'asdk.local.set("leak", typeof invocationLeak);',
      preInput(),
    );

    expect(first.request.body).toMatchObject({
      kind: "binary",
      readable: true,
      sensitive: false,
    });
    expect(
      first.request.body.kind === "binary"
        ? new TextDecoder().decode(first.request.body.bytes)
        : undefined,
    ).toBe("hello");
    expect(second.local).toEqual({ leak: "undefined" });
  });

  it("keeps quotas effective when scripts try to replace built-ins", async () => {
    service = new ScriptService();

    await expect(
      service.runPreRequest(
        `
          JSON.stringify = () => "";
          Object.keys = () => [];
          Array.prototype.map = () => [];
          asdk.log.info("first");
          asdk.log.info("second");
        `,
        { ...preInput(), limits: { logEntries: 1 } },
      ),
    ).rejects.toMatchObject({ code: "output_limit_exceeded" });
  });

  it("reports unavailable response bodies as errored tests", async () => {
    service = new ScriptService();
    const input = postInput();

    const result = await service.runPostResponse(
      `
        asdk.test("body", () => asdk.response.body.text());
        asdk.test("status", () => asdk.assert.equal(asdk.response.status, 200));
        asdk.test("truthy", () => asdk.assert.ok(false));
      `,
      {
        ...input,
        response: {
          ...input.response,
          body: {
            size: 20_000_000,
            sha256: "digest",
            available: false,
            unavailableReason: "too_large",
          },
        },
      },
    );

    expect(result.tests).toEqual([
      {
        sequence: 1,
        name: "body",
        status: "errored",
        message: "Response body is unavailable",
      },
      {
        sequence: 2,
        name: "status",
        status: "failed",
        message: "Values are not equal",
        messageCode: "assertion_values_not_equal",
      },
      {
        sequence: 3,
        name: "truthy",
        status: "failed",
        message: "Expected a truthy value",
        messageCode: "assertion_expected_truthy",
      },
    ]);
  });

  it("interrupts non-terminating scripts", async () => {
    service = new ScriptService();

    await expect(
      service.runPreRequest("while (true) {}", {
        ...preInput(),
        limits: { wallTimeMilliseconds: 100 },
      }),
    ).rejects.toMatchObject({
      code: "time_limit_exceeded",
    });
  });

  it("enforces the QuickJS heap limit", async () => {
    service = new ScriptService();

    await expect(
      service.runPreRequest(
        `
          const values = [];
          while (true) values.push(new Uint8Array(1_000_000));
        `,
        {
          ...preInput(),
          limits: { memoryBytes: 4_194_304, wallTimeMilliseconds: 2000 },
        },
      ),
    ).rejects.toMatchObject({ code: "memory_limit_exceeded" });
  });
});
