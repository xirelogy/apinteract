import { describe, expect, it } from "vitest";
import {
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  type PluginPackageManifest,
} from "@apinteract/plugin-api";
import type { FrontendPluginModule } from "@apinteract/plugin-api/frontend";

import { createFrontendPluginRuntime } from "../src/app/plugins/frontend-plugin-host";
import { createTestFrontendPluginRuntime } from "./plugin-fixtures";
import type { ExecutionView } from "../src/model/contracts/backend";
import {
  analyzeResponseContent as analyzeWithPresenters,
  isResponsePreviewComplete,
  ResponseContentPresenterRegistry,
  responseMediaType,
} from "../src/model/domain/response-content";

const builtinPresenters = createTestFrontendPluginRuntime().responseContent;

/** Analyzes through built-ins unless a test supplies an isolated registry. */
function analyzeResponseContent(
  execution: ExecutionView,
  capturedResponse = false,
  presenters = builtinPresenters,
) {
  return analyzeWithPresenters(execution, capturedResponse, presenters);
}

/** Creates a terminal execution with overridable response evidence. */
function execution(overrides: Partial<ExecutionView> = {}): ExecutionView {
  return {
    executionId: "019fa8be-a510-76b9-b73b-69f4c7af7901",
    state: "completed",
    bodyComplete: true,
    bodyBytes: 0,
    createdAt: "2026-08-29T00:00:00.000Z",
    completedAt: "2026-08-29T00:00:01.000Z",
    scriptLogs: [],
    scriptTests: [],
    ...overrides,
  };
}

describe("response content analysis", () => {
  it("normalizes declared media types without sniffing malformed values", () => {
    expect(
      responseMediaType([
        {
          name: "CONTENT-TYPE",
          value: " Application/Problem+JSON ; charset=utf-8",
        },
      ]),
    ).toBe("application/problem+json");
    expect(
      responseMediaType([{ name: "content-type", value: "not a media type" }]),
    ).toBeNull();
    expect(responseMediaType(undefined)).toBeNull();
  });

  it("requires complete UTF-8 byte evidence for a derived view", () => {
    expect(
      isResponsePreviewComplete(execution({ bodyBytes: 2, bodyPreview: "é" })),
    ).toBe(true);
    expect(
      isResponsePreviewComplete(execution({ bodyBytes: 3, bodyPreview: "é" })),
    ).toBe(false);
    expect(
      isResponsePreviewComplete(
        execution({ bodyComplete: false, bodyBytes: 2, bodyPreview: "é" }),
      ),
    ).toBe(false);
  });

  it("selects an executable JSON viewer and makes valid complete content default", () => {
    const source = '{"value":9007199254740993,"value":2,"items":[true,null]}';
    const analysis = analyzeResponseContent(
      execution({
        headers: [{ name: "content-type", value: "application/problem+json" }],
        bodyBytes: source.length,
        bodyPreview: source,
      }),
    );

    expect(analysis.state).toBe("text");
    expect(analysis.viewer?.id).toMatch(/\/json$/u);
    expect(analysis.viewerIsDefault).toBe(true);
  });

  it("keeps invalid or truncated JSON viewers available without selecting them", () => {
    const invalid = '{"value":}';
    expect(
      analyzeResponseContent(
        execution({
          headers: [{ name: "content-type", value: "application/json" }],
          bodyBytes: invalid.length,
          bodyPreview: invalid,
        }),
      ).viewerIsDefault,
    ).toBe(false);

    const truncated = '{"value":';
    expect(
      analyzeResponseContent(
        execution({
          headers: [{ name: "content-type", value: "application/json" }],
          bodyBytes: 2000,
          bodyPreview: truncated,
        }),
      ).viewerIsDefault,
    ).toBe(false);
  });

  it("parses XML without treating SVG as a directly renderable image", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>';
    const analysis = analyzeResponseContent(
      execution({
        headers: [{ name: "content-type", value: "image/svg+xml" }],
        bodyBytes: source.length,
        bodyPreview: source,
      }),
    );

    expect(analysis.viewer?.id).toMatch(/\/xml$/u);
    expect(analysis.viewerIsDefault).toBe(true);
  });

  it("prefers the exact executable HTML viewer over the XML suffix viewer", () => {
    const source =
      '<html xmlns="http://www.w3.org/1999/xhtml"><p>OK</p></html>';
    const analysis = analyzeResponseContent(
      execution({
        headers: [{ name: "content-type", value: "application/xhtml+xml" }],
        bodyBytes: source.length,
        bodyPreview: source,
      }),
    );

    expect(analysis.viewer?.id).toMatch(/\/html$/u);
    expect(analysis.viewerIsDefault).toBe(false);
  });

  it("allows a contributed presenter to override a built-in deliberately", () => {
    const yamlManifest: PluginPackageManifest<"frontend"> = {
      schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
      apiVersion: PLUGIN_API_VERSION,
      id: "example.yaml-response",
      name: "YAML response support",
      version: "1.0.0",
      target: "frontend",
      entrypoint: "dist/index.mjs",
      providers: ["response.content"],
    };
    const yamlPlugin: FrontendPluginModule = {
      /** Registers one response presenter through the frontend plugin host. */
      register(context) {
        context.register("response.content", {
          id: "yaml",
          label: { default: "YAML" },
          mediaTypes: ["application/yaml", "*+yaml"],
          mountView: () => ({
            /** Accepts lifecycle updates for the executable test view. */
            update() {},
            /** Releases the executable test view. */
            destroy() {},
          }),
        });
      },
    };
    const runtime = createTestFrontendPluginRuntime();
    runtime.plugins.install(yamlManifest, yamlPlugin, "user");
    const source = "value: true";
    expect(
      analyzeResponseContent(
        execution({
          headers: [
            { name: "content-type", value: "application/example+yaml" },
          ],
          bodyBytes: source.length,
          bodyPreview: source,
        }),
        false,
        runtime.responseContent,
      ).viewer?.id,
    ).toMatch(/\/yaml$/u);
    expect(runtime.plugins.has("example.yaml-response")).toBe(true);

    expect(createFrontendPluginRuntime().responseContent).toBeInstanceOf(
      ResponseContentPresenterRegistry,
    );
  });

  it("distinguishes raster, textual, binary, empty, and unavailable bodies", () => {
    expect(
      analyzeWithPresenters(
        execution({
          headers: [{ name: "content-type", value: "image/png" }],
          bodyBytes: 24,
          bodyBlobId: "019fa8be-a510-76b9-b73b-69f4c7af7902",
        }),
        false,
        builtinPresenters,
        () => Promise.resolve(new Blob()),
      ).viewer?.id,
    ).toMatch(/\/raster-image$/u);
    expect(
      analyzeResponseContent(execution({ bodyBytes: 4, bodyPreview: "text" }))
        .state,
    ).toBe("text");
    expect(
      analyzeResponseContent(execution({ bodyBytes: 4, bodyBlobId: "blob" }))
        .state,
    ).toBe("binary");
    expect(analyzeResponseContent(execution()).state).toBe("empty");
    expect(
      analyzeResponseContent(execution({ bodyBytes: 4 }), true).state,
    ).toBe("unavailable");
  });

  it("does not expose partial frontend contributions after a conflict", () => {
    const runtime = createFrontendPluginRuntime();
    const manifest: PluginPackageManifest<"frontend"> = {
      schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
      apiVersion: PLUGIN_API_VERSION,
      id: "example.atomic",
      name: "Atomic example",
      version: "1.0.0",
      target: "frontend",
      entrypoint: "dist/index.mjs",
      providers: ["response.content"],
    };
    const plugin: FrontendPluginModule = {
      /** Registers conflicting presenters to exercise package rollback. */
      register(context) {
        context.register("response.content", {
          id: "first",
          label: { default: "First" },
          mediaTypes: ["application/example"],
          mountView: () => ({
            /** Accepts lifecycle updates for the executable test view. */
            update() {},
            /** Releases the executable test view. */
            destroy() {},
          }),
        });
        context.register("response.content", {
          id: "second",
          label: { default: "Second" },
          mediaTypes: ["application/example"],
          mountView: () => ({
            /** Accepts lifecycle updates for the executable test view. */
            update() {},
            /** Releases the executable test view. */
            destroy() {},
          }),
        });
      },
    };

    expect(() => runtime.plugins.install(manifest, plugin, "user")).toThrow(
      /conflicts/u,
    );
    expect(runtime.responseContent.list()).toEqual([]);
    expect(runtime.plugins.list()).toEqual([]);
  });
});
