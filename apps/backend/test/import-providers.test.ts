import { describe, expect, it } from "vitest";

import { HarImportProvider } from "../src/imports/har-provider.js";
import { ImportProviderRegistry } from "../src/imports/import-provider-registry.js";
import { OpenApiJsonImportProvider } from "../src/imports/openapi-json-provider.js";

describe("import providers", () => {
  it("detects and maps OpenAPI operations into composed request plans", async () => {
    const registry = new ImportProviderRegistry([
      new OpenApiJsonImportProvider(),
      new HarImportProvider(),
    ]);
    const plan = await registry.preview(null, {
      name: "pets.json",
      text: JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Pet API", version: "1" },
        servers: [{ url: "https://api.example.test/v1" }],
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer" },
          },
        },
        security: [{ bearerAuth: [] }],
        paths: {
          "/pets/{petId}": {
            parameters: [
              {
                name: "petId",
                in: "path",
                required: true,
                schema: { type: "string", example: "p-1" },
              },
            ],
            get: {
              summary: "Get pet",
              parameters: [
                {
                  name: "include",
                  in: "query",
                  schema: { type: "string" },
                },
              ],
            },
            put: {
              operationId: "replacePet",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        name: { type: "string", example: "Mochi" },
                      },
                    },
                  },
                  "text/plain": { schema: { type: "string" } },
                },
              },
            },
          },
        },
      }),
    });

    expect(plan.providerId).toBe("openapi-json");
    expect(plan.suggestedName).toBe("Pet API");
    expect(plan.pathPrefix).toBe("https://api.example.test/v1");
    expect(plan.requests).toHaveLength(2);
    expect(plan.requests[0]).toMatchObject({
      name: "Get pet",
      method: "GET",
      targetMode: "composed",
      targetUrl: "/pets/<<petId>>",
      query: [{ name: "include", value: "", enabled: false }],
      headers: [
        {
          name: "Authorization",
          value: "Bearer <<bearerAuth>>",
          enabled: true,
        },
      ],
    });
    expect(plan.requests[0]?.variables).toEqual([
      { name: "petId", kind: "value", value: "p-1" },
      { name: "bearerAuth", kind: "secret" },
    ]);
    expect(plan.requests[1]?.requestBody).toMatchObject({
      kind: "text",
      contentType: "application/json",
      text: '{\n  "name": "Mochi"\n}',
    });
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: "openapi_body_media_type_selected" }),
    );
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "openapi_security_secret_unconfigured",
        severity: "warning",
        message:
          "Security scheme bearerAuth was imported as unconfigured secret variable bearerAuth; set its value before sending requests.",
      }),
    );
  });

  it("maps HAR credentials and recorded responses without creating executions", async () => {
    const registry = new ImportProviderRegistry([new HarImportProvider()]);
    const plan = await registry.preview("har", {
      name: "session.har",
      text: JSON.stringify({
        log: {
          version: "1.2",
          entries: [
            {
              startedDateTime: "2025-01-02T03:04:05.000Z",
              request: {
                method: "POST",
                url: "https://example.test/items?draft=true",
                headers: [
                  { name: ":authority", value: "example.test" },
                  { name: ":method", value: "POST" },
                  { name: "Authorization", value: "Bearer secret" },
                  { name: "Content-Length", value: "7" },
                  { name: "X-Client", value: "test" },
                ],
                postData: {
                  mimeType: "application/x-www-form-urlencoded",
                  params: [{ name: "name", value: "Mochi" }],
                },
              },
              response: {
                status: 201,
                statusText: "Created",
                headers: [
                  { name: ":status", value: "201" },
                  { name: "Content-Type", value: "application/json" },
                  { name: "Set-Cookie", value: "session=secret" },
                ],
                content: {
                  mimeType: "application/json",
                  size: 11,
                  text: '{"ok":true}',
                },
              },
            },
          ],
        },
      }),
    });

    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0]).toMatchObject({
      method: "POST",
      targetUrl: "https://example.test/items",
      query: [{ name: "draft", value: "true", enabled: true }],
      headers: [
        {
          name: "Authorization",
          value: "<<imported_authorization>>",
          enabled: true,
        },
        { name: "X-Client", value: "test", enabled: true },
      ],
      variables: [
        {
          name: "imported_authorization",
          kind: "secret",
          value: "Bearer secret",
        },
      ],
      capturedExchange: {
        source: "har",
        status: 201,
        body: '{"ok":true}',
        bodyEncoding: "text",
        recordedAt: "2025-01-02T03:04:05.000Z",
      },
    });
    expect(plan.requests[0]?.capturedExchange?.headers[1]?.value).toBe(
      "[redacted]",
    );
    expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "har_pseudo_header_omitted",
        "har_response_pseudo_header_omitted",
        "har_sensitive_header_secretized",
        "har_derived_header_omitted",
      ]),
    );
  });

  it("marks WS and WSS HAR entries as blocked import items", async () => {
    const plan = await new ImportProviderRegistry([
      new HarImportProvider(),
    ]).preview("har", {
      name: "websockets.har",
      text: JSON.stringify({
        log: {
          version: "1.2",
          entries: ["ws", "wss"].map((scheme) => ({
            request: {
              method: "GET",
              url: `${scheme}://example.test/socket`,
              headers: [],
            },
          })),
        },
      }),
    });

    expect(plan.requests).toHaveLength(2);
    expect(plan.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "har_websocket_unsupported",
          severity: "error",
          itemId: "entry:0",
        }),
        expect.objectContaining({
          code: "har_websocket_unsupported",
          severity: "error",
          itemId: "entry:1",
        }),
      ]),
    );
  });

  it("reports response bytes omitted from the HAR source", async () => {
    const plan = await new ImportProviderRegistry([
      new HarImportProvider(),
    ]).preview("har", {
      name: "without-content.har",
      text: JSON.stringify({
        log: {
          version: "1.2",
          entries: [
            {
              request: {
                method: "GET",
                url: "https://example.test/data",
                headers: [],
              },
              response: {
                status: 200,
                statusText: "OK",
                headers: [],
                content: { mimeType: "application/json", size: 84 },
              },
            },
          ],
        },
      }),
    });

    expect(plan.requests[0]?.capturedExchange).toMatchObject({
      body: "",
      bodyBytes: 84,
      bodyComplete: false,
    });
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "har_response_body_unavailable",
        severity: "warning",
        itemId: "entry:0",
      }),
    );
  });
});
