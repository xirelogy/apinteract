import { describe, expect, it } from "vitest";
import type { FrontendPlugin } from "@apinteract/plugin-api/frontend";

import { createFrontendPluginRuntime } from "../src/app/plugins/frontend-plugin-host";
import type { ExecutionView } from "../src/model/contracts/backend";
import {
  analyzeResponseContent as analyzeWithPresenters,
  isRasterImageMediaType,
  isResponsePreviewComplete,
  ResponseContentPresenterRegistry,
  responseMediaType,
} from "../src/model/domain/response-content";

const builtinPresenters = createFrontendPluginRuntime().responseContent;

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

  it("formats valid JSON without changing duplicate members or number lexemes", () => {
    const source = '{"value":9007199254740993,"value":2,"items":[true,null]}';
    const analysis = analyzeResponseContent(
      execution({
        headers: [{ name: "content-type", value: "application/problem+json" }],
        bodyBytes: source.length,
        bodyPreview: source,
      }),
    );

    expect(analysis.kind).toBe("json");
    expect(analysis.structured).toEqual({
      language: "json",
      valid: true,
      value:
        '{\n  "value": 9007199254740993,\n  "value": 2,\n  "items": [\n    true,\n    null\n  ]\n}',
    });
  });

  it("does not create a parsed JSON view for invalid or truncated content", () => {
    const invalid = '{"value":}';
    expect(
      analyzeResponseContent(
        execution({
          headers: [{ name: "content-type", value: "application/json" }],
          bodyBytes: invalid.length,
          bodyPreview: invalid,
        }),
      ).structured,
    ).toEqual({ language: "json", valid: false });

    const truncated = '{"value":';
    expect(
      analyzeResponseContent(
        execution({
          headers: [{ name: "content-type", value: "application/json" }],
          bodyBytes: 2000,
          bodyPreview: truncated,
        }),
      ).structured,
    ).toBeUndefined();
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

    expect(analysis.kind).toBe("xml");
    expect(analysis.structured).toEqual({
      language: "xml",
      valid: true,
      value: source,
    });
    expect(isRasterImageMediaType("image/svg+xml")).toBe(false);
  });

  it("offers both XML structure and HTML capability for valid XHTML", () => {
    const source =
      '<html xmlns="http://www.w3.org/1999/xhtml"><p>OK</p></html>';
    const analysis = analyzeResponseContent(
      execution({
        headers: [{ name: "content-type", value: "application/xhtml+xml" }],
        bodyBytes: source.length,
        bodyPreview: source,
      }),
    );

    expect(analysis.kind).toBe("html");
    expect(analysis.structured?.valid).toBe(true);
  });

  it("allows a contributed presenter to override a built-in deliberately", () => {
    const yamlPlugin: FrontendPlugin = {
      manifest: {
        apiVersion: 1,
        id: "example.yaml-response",
        name: "YAML response support",
        version: "1.0.0",
        target: "frontend",
      },
      /** Registers one response presenter through the frontend plugin host. */
      register(context) {
        context.register("response.content", {
          id: "yaml",
          mediaTypes: ["application/yaml", "*+yaml"],
          present: () => ({ kind: "text" }),
        });
      },
    };
    const runtime = createFrontendPluginRuntime();
    runtime.plugins.install(yamlPlugin);
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
      ).kind,
    ).toBe("text");
    expect(runtime.plugins.has("example.yaml-response")).toBe(true);

    expect(createFrontendPluginRuntime().responseContent).toBeInstanceOf(
      ResponseContentPresenterRegistry,
    );
  });

  it("distinguishes raster, textual, binary, empty, and unavailable bodies", () => {
    expect(
      analyzeResponseContent(
        execution({
          headers: [{ name: "content-type", value: "image/png" }],
          bodyBytes: 24,
          bodyBlobId: "019fa8be-a510-76b9-b73b-69f4c7af7902",
        }),
      ).kind,
    ).toBe("image");
    expect(
      analyzeResponseContent(execution({ bodyBytes: 4, bodyPreview: "text" }))
        .kind,
    ).toBe("text");
    expect(
      analyzeResponseContent(execution({ bodyBytes: 4, bodyBlobId: "blob" }))
        .kind,
    ).toBe("binary");
    expect(analyzeResponseContent(execution()).kind).toBe("empty");
    expect(analyzeResponseContent(execution({ bodyBytes: 4 }), true).kind).toBe(
      "unavailable",
    );
  });
});
