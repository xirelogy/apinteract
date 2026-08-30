import { describe, expect, it } from "vitest";
import type { BackendPlugin } from "@apinteract/plugin-api/backend";

import { createBackendPluginRuntime } from "../src/plugins/backend-plugin-host.js";

const exampleImportPlugin: BackendPlugin = {
  manifest: {
    apiVersion: 1,
    id: "example.single-request",
    name: "Single request import",
    version: "1.0.0",
    target: "backend",
  },
  /** Registers one minimal provider used to exercise backend plugin routing. */
  register(context) {
    context.register("request.import", {
      manifest: {
        id: "example-request",
        version: "1.0.0",
        label: "Example request",
        acceptedExtensions: [".request"],
        acceptedMediaTypes: ["text/plain"],
        inputKinds: ["file"],
        capabilities: {
          multipleRequests: false,
          hierarchy: false,
          attachments: false,
          capturedResponses: false,
          responseExamples: false,
          variables: false,
        },
      },
      probe: () => ({ confidence: 1, reason: "Example request" }),
      parse: (source) => ({
        schemaVersion: 1,
        providerId: "example-request",
        providerVersion: "1.0.0",
        sourceName: source.name,
        suggestedName: source.name,
        description: "",
        notes: "",
        pathPrefix: "",
        variables: [],
        collections: [],
        requests: [
          {
            itemId: "request-1",
            sourceLocation: "line:1",
            collectionKey: null,
            name: source.name,
            description: "",
            notes: "",
            method: "GET",
            targetMode: "absolute",
            targetUrl: source.text,
            query: [],
            headers: [],
            requestBody: { kind: "none" },
            body: "",
            preRequestScript: "",
            postResponseScript: "",
            variables: [],
          },
        ],
        diagnostics: [],
      }),
    });
  },
};

describe("backend plugin host", () => {
  it("installs a backend import plugin through the shared package signature", async () => {
    const runtime = createBackendPluginRuntime([]);
    runtime.plugins.install(exampleImportPlugin);

    expect(runtime.plugins.has("example.single-request")).toBe(true);
    expect(runtime.imports.manifests().map((provider) => provider.id)).toEqual([
      "example-request",
    ]);
    await expect(
      runtime.imports.preview("example-request", {
        name: "health.request",
        text: "https://example.test/health",
      }),
    ).resolves.toMatchObject({
      providerId: "example-request",
      suggestedName: "health.request",
    });
  });

  it("rejects duplicate plugin packages before re-registration", () => {
    const runtime = createBackendPluginRuntime([]);
    runtime.plugins.install(exampleImportPlugin);
    expect(() => runtime.plugins.install(exampleImportPlugin)).toThrow(
      /already installed/u,
    );
  });
});
