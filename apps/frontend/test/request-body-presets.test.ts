import { describe, expect, it } from "vitest";
import type { FrontendPlugin } from "@apinteract/plugin-api/frontend";

import { createFrontendPluginRuntime } from "../src/app/plugins/frontend-plugin-host";

describe("request body preset registry", () => {
  it("exposes built-ins in presentation order", () => {
    expect(
      createFrontendPluginRuntime()
        .requestContent.list()
        .map((preset) => preset.id),
    ).toEqual(["none", "text", "json", "urlencoded", "multipart", "file"]);
  });

  it("selects structured suffixes while retaining a plain-text fallback", () => {
    const registry = createFrontendPluginRuntime().requestContent;
    expect(
      registry.resolveBody({
        kind: "text",
        contentType: "application/problem+json; charset=utf-8",
        text: "{}",
      }).id,
    ).toBe("json");
    expect(
      registry.resolveBody({
        kind: "text",
        contentType: "application/yaml",
        text: "value: true",
      }).id,
    ).toBe("text");
    expect(registry.resolveBody({ kind: "none" }).id).toBe("none");
  });

  it("accepts contributed presets backed by safe host editor primitives", () => {
    const yamlPlugin: FrontendPlugin = {
      manifest: {
        apiVersion: 1,
        id: "example.yaml",
        name: "YAML content",
        version: "1.0.0",
        target: "frontend",
      },
      /** Registers a request editor preset through the frontend plugin host. */
      register(context) {
        context.register("request.content", {
          id: "yaml",
          label: { default: "YAML" },
          bodyKind: "text",
          defaultContentType: "application/yaml",
          mediaTypes: ["application/yaml", "*+yaml"],
          textLanguage: "plain",
          format: (source) => ({ valid: true, value: source.trim() }),
        });
      },
    };
    const runtime = createFrontendPluginRuntime();
    runtime.plugins.install(yamlPlugin);
    const registry = runtime.requestContent;

    expect(
      registry.resolveBody({
        kind: "text",
        contentType: "application/example+yaml",
        text: "value: true",
      }).id,
    ).toBe("yaml");
    expect(registry.format("yaml", "  value: true\n")).toEqual({
      valid: true,
      value: "value: true",
    });
    expect(runtime.plugins.has("example.yaml")).toBe(true);
  });
});
