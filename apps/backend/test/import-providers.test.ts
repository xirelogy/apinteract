import { describe, expect, it } from "vitest";

import { HarImportProvider } from "../../../plugins/har-import/src/har-provider.js";
import { ImportProviderRegistry } from "../src/imports/import-provider-registry.js";
import { OpenApiJsonImportProvider } from "../../../plugins/openapi-import/src/openapi-json-provider.js";

describe("import providers", () => {
  it("lists providers by plugin weight with registration order as the tie-breaker", () => {
    const registry = new ImportProviderRegistry();
    registry.register(new HarImportProvider(), 0);
    registry.register(new OpenApiJsonImportProvider(), 10);

    expect(registry.manifests().map((provider) => provider.id)).toEqual([
      "openapi-json",
      "har",
    ]);
  });

  it("detects and maps OpenAPI operations into composed request plans", async () => {
    const registry = new ImportProviderRegistry([
      new OpenApiJsonImportProvider(),
      new HarImportProvider(),
    ]);
    const plan = await registry.preview(null, {
      name: "pets.json",
      text: JSON.stringify({
        openapi: "3.1.0",
        info: {
          title: "Pet API",
          summary: "Pet operations",
          description: "# Pet API notes",
          version: "1",
        },
        servers: [
          {
            url: "https://api.example.test/v1",
            description: "Production endpoint",
          },
        ],
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer" },
          },
        },
        security: [{ bearerAuth: [] }],
        paths: {
          "/pets/{petId}": {
            summary: "Pet resource",
            description: "Operations on individual pets.",
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
              description: "Returns one pet.",
              parameters: [
                {
                  name: "include",
                  in: "query",
                  schema: { type: "string" },
                  description: "Related resources to include",
                },
              ],
            },
            put: {
              operationId: "replacePet",
              requestBody: {
                description: "Complete replacement payload.",
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
    expect(plan.description).toBe("Pet operations");
    expect(plan.notes).toBe("# Pet API notes\n\nProduction endpoint");
    expect(plan.pathPrefix).toBe("https://api.example.test/v1");
    expect(plan.variables).toEqual([
      { name: "petId", kind: "value", value: "p-1" },
      { name: "bearerAuth", kind: "secret" },
    ]);
    expect(plan.collections).toEqual([
      expect.objectContaining({
        parentCollectionKey: null,
        name: "/pets/{petId}",
        description: "Pet resource",
        notes: "Operations on individual pets.",
        pathPrefix: "/pets/<<petId>>",
        variables: [],
      }),
    ]);
    expect(plan.requests).toHaveLength(2);
    expect(plan.requests[0]).toMatchObject({
      name: "Get pet",
      description: "Get pet",
      notes: "Returns one pet.",
      method: "GET",
      targetMode: "composed",
      targetUrl: "",
      query: [
        {
          name: "include",
          value: "",
          enabled: false,
          description: "Related resources to include",
        },
      ],
      headers: [
        {
          name: "Authorization",
          value: "Bearer <<bearerAuth>>",
          enabled: true,
        },
      ],
    });
    expect(plan.requests[0]?.collectionKey).toBe(
      plan.collections[0]?.collectionKey,
    );
    expect(plan.requests[1]?.collectionKey).toBe(
      plan.collections[0]?.collectionKey,
    );
    expect(plan.requests[0]?.variables).toEqual([]);
    expect(plan.requests[1]?.requestBody).toMatchObject({
      kind: "text",
      contentType: "application/json",
      text: '{\n  "name": "Mochi"\n}',
    });
    expect(plan.requests[1]?.notes).toBe("Complete replacement payload.");
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
    expect(
      plan.diagnostics.find(
        (diagnostic) =>
          diagnostic.code === "openapi_security_secret_unconfigured",
      )?.itemIds,
    ).toEqual(["operation:GET:/pets/{petId}", "operation:PUT:/pets/{petId}"]);
  });

  it("groups composed OpenAPI requests by effective server precedence", async () => {
    const plan = await new ImportProviderRegistry([
      new OpenApiJsonImportProvider(),
    ]).preview("openapi-json", {
      name: "servers.json",
      text: JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Server groups", version: "1" },
        servers: [
          {
            url: "https://document.example.test/{version}/",
            variables: { version: { default: "v1" } },
          },
        ],
        paths: {
          "/document": { get: {} },
          "/path": {
            servers: [{ url: "https://path.example.test/base" }],
            get: {},
            post: {
              servers: [
                { url: "https://operation.example.test/api" },
                { url: "https://unused.example.test" },
              ],
            },
          },
        },
      }),
    });

    expect(plan.pathPrefix).toBe("");
    expect(plan.collections).toHaveLength(6);
    expect(
      plan.collections
        .filter((collection) => collection.parentCollectionKey === null)
        .map((collection) => collection.pathPrefix),
    ).toEqual([
      "https://document.example.test/<<version>>",
      "https://path.example.test/base",
      "https://operation.example.test/api",
    ]);
    expect(plan.variables).toEqual([
      { name: "version", kind: "value", value: "v1" },
    ]);
    expect(
      plan.collections.every((collection) => collection.variables.length === 0),
    ).toBe(true);
    expect(
      new Set(plan.requests.map((request) => request.collectionKey)).size,
    ).toBe(3);
    expect(
      plan.requests.every((request) => request.targetMode === "composed"),
    ).toBe(true);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "openapi_server_selected",
        itemId: "operation:POST:/path",
      }),
    );
  });

  it("keeps conflicting OpenAPI defaults at root without request overrides", async () => {
    const plan = await new ImportProviderRegistry([
      new OpenApiJsonImportProvider(),
    ]).preview("openapi-json", {
      name: "overrides.json",
      text: JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Overrides", version: "1" },
        paths: {
          "/items/{id}": {
            get: {
              parameters: [
                {
                  name: "id",
                  in: "path",
                  description: "Canonical item identifier",
                  schema: { default: "common" },
                },
              ],
            },
            post: {
              parameters: [
                {
                  name: "id",
                  in: "path",
                  description: "Alternate item identifier",
                  schema: { default: "special" },
                },
              ],
            },
            delete: {
              parameters: [
                { name: "id", in: "path", schema: { default: "common" } },
              ],
            },
          },
        },
      }),
    });

    expect(plan.variables).toEqual([
      {
        name: "id",
        kind: "value",
        value: "common",
        description: "Canonical item identifier",
      },
    ]);
    expect(plan.collections).toEqual([
      expect.objectContaining({
        name: "/items/{id}",
        pathPrefix: "/items/<<id>>",
        variables: [],
      }),
    ]);
    expect(
      plan.requests.every((request) => request.variables.length === 0),
    ).toBe(true);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "openapi_variable_default_conflict",
        severity: "warning",
        itemIds: ["operation:GET:/items/{id}", "operation:POST:/items/{id}"],
      }),
    );
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "openapi_variable_description_conflict",
        severity: "warning",
        itemIds: ["operation:GET:/items/{id}", "operation:POST:/items/{id}"],
      }),
    );
  });

  it("keeps the first non-empty description for a deduplicated OpenAPI variable", async () => {
    const plan = await new ImportProviderRegistry([
      new OpenApiJsonImportProvider(),
    ]).preview("openapi-json", {
      name: "documented-variable.json",
      text: JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Documented variable", version: "1" },
        paths: {
          "/items/{id}": {
            get: {
              parameters: [
                { name: "id", in: "path", schema: { default: "item" } },
              ],
            },
            post: {
              parameters: [
                {
                  name: "id",
                  in: "path",
                  description: "Item identifier",
                  schema: { default: "item" },
                },
              ],
            },
          },
        },
      }),
    });

    expect(plan.variables).toEqual([
      {
        name: "id",
        kind: "value",
        value: "item",
        description: "Item identifier",
      },
    ]);
    expect(plan.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: "openapi_variable_description_conflict",
      }),
    );
  });

  it("preserves primary OpenAPI tags above their path collections", async () => {
    const plan = await new ImportProviderRegistry([
      new OpenApiJsonImportProvider(),
    ]).preview("openapi-json", {
      name: "tagged.json",
      text: JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Tagged API", version: "1" },
        servers: [{ url: "https://api.example.test" }],
        tags: [
          { name: "Pets", description: "Pet endpoints" },
          { name: "Owners", description: "Owner endpoints" },
        ],
        paths: {
          "/owners": { get: { tags: ["Owners"] } },
          "/pets": { get: { tags: ["Pets", "Public"] } },
          "/pets/{id}": { get: { tags: ["Pets"] } },
        },
      }),
    });

    const pets = plan.collections.find(
      (collection) => collection.name === "Pets",
    );
    const owners = plan.collections.find(
      (collection) => collection.name === "Owners",
    );
    expect(pets?.parentCollectionKey).toBeNull();
    expect(pets?.notes).toBe("Pet endpoints");
    expect(owners?.parentCollectionKey).toBeNull();
    expect(owners?.notes).toBe("Owner endpoints");
    expect(
      plan.collections
        .filter((collection) => collection.parentCollectionKey === null)
        .map((collection) => collection.name),
    ).toEqual(["Pets", "Owners"]);
    expect(
      plan.collections
        .filter(
          (collection) =>
            collection.parentCollectionKey === pets?.collectionKey,
        )
        .map((collection) => collection.name),
    ).toEqual(["/pets", "/pets/{id}"]);
    expect(
      plan.requests
        .filter((request) => request.name.includes("/pets"))
        .every((request) =>
          plan.collections.some(
            (collection) =>
              collection.collectionKey === request.collectionKey &&
              collection.parentCollectionKey === pets?.collectionKey,
          ),
        ),
    ).toBe(true);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "openapi_additional_tags_not_grouped",
        itemId: "operation:GET:/pets",
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
              comment: "Recorded create-item exchange",
              startedDateTime: "2025-01-02T03:04:05.000Z",
              request: {
                comment: "Creates one item",
                method: "POST",
                url: "https://example.test/items?draft=true",
                headers: [
                  { name: ":authority", value: "example.test" },
                  { name: ":method", value: "POST" },
                  { name: "Authorization", value: "Bearer secret" },
                  { name: "Content-Length", value: "7" },
                  {
                    name: "X-Client",
                    value: "test",
                    comment: "Calling application",
                  },
                ],
                postData: {
                  comment: "Submitted item fields",
                  mimeType: "application/x-www-form-urlencoded",
                  params: [
                    { name: "name", value: "Mochi", comment: "Item name" },
                  ],
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
      description: "Creates one item",
      notes:
        "Recorded create-item exchange\n\nCreates one item\n\nSubmitted item fields",
      targetUrl: "https://example.test/items",
      query: [{ name: "draft", value: "true", enabled: true }],
      headers: [
        {
          name: "Authorization",
          value: "<<imported_authorization>>",
          enabled: true,
        },
        {
          name: "X-Client",
          value: "test",
          enabled: true,
          description: "Calling application",
        },
      ],
      variables: [],
      capturedExchange: {
        source: "har",
        status: 201,
        body: '{"ok":true}',
        bodyEncoding: "text",
        recordedAt: "2025-01-02T03:04:05.000Z",
      },
    });
    expect(plan.requests[0]?.requestBody).toMatchObject({
      fields: [expect.objectContaining({ description: "Item name" })],
    });
    expect(plan.variables).toEqual([
      {
        name: "imported_authorization",
        kind: "secret",
        value: "Bearer secret",
      },
    ]);
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
    expect(plan.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "har_pseudo_header_omitted",
          message:
            "HTTP pseudo-headers omitted from requests: :authority, :method.",
          itemIds: ["entry:0"],
        }),
        expect.objectContaining({
          code: "har_response_pseudo_header_omitted",
          message:
            "HTTP pseudo-headers omitted from captured responses: :status.",
        }),
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
