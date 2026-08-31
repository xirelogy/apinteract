import { describe, expect, it } from "vitest";
import type { PluginPackageManifest } from "@apinteract/plugin-api";
import type { FrontendPluginModule } from "@apinteract/plugin-api/frontend";

import { createTestFrontendPluginRuntime } from "./plugin-fixtures";

describe("request body preset registry", () => {
  it("exposes built-ins in presentation order", () => {
    expect(
      createTestFrontendPluginRuntime()
        .requestContent.list()
        .map((preset) => preset.id),
    ).toEqual([
      "apinteract.basic-http-content/none",
      "apinteract.basic-http-content/text",
      "apinteract.json-content/json",
      "apinteract.xml-content/xml",
      "apinteract.basic-http-content/urlencoded",
      "apinteract.basic-http-content/multipart",
      "apinteract.basic-http-content/file",
    ]);
  });

  it("selects structured suffixes while retaining a plain-text fallback", () => {
    const registry = createTestFrontendPluginRuntime().requestContent;
    expect(
      registry.resolveBody({
        kind: "text",
        contentType: "application/problem+json; charset=utf-8",
        text: "{}",
      }).id,
    ).toBe("apinteract.json-content/json");
    expect(
      registry.resolveBody({
        kind: "text",
        contentType: "application/problem+xml; charset=utf-8",
        text: "<problem />",
      }).id,
    ).toBe("apinteract.xml-content/xml");
    expect(
      registry.resolveBody({
        kind: "text",
        contentType: "application/yaml",
        text: "value: true",
      }).id,
    ).toBe("apinteract.basic-http-content/text");
    expect(registry.resolveBody({ kind: "none" }).id).toBe(
      "apinteract.basic-http-content/none",
    );
  });

  it("accepts contributed executable editors backed by host mechanisms", () => {
    const yamlManifest: PluginPackageManifest<"frontend"> = {
      schemaVersion: 1,
      apiVersion: 2,
      id: "example.yaml",
      name: "YAML content",
      version: "1.0.0",
      weight: 10,
      target: "frontend",
      entrypoint: "dist/index.mjs",
      providers: ["request.content"],
    };
    const yamlPlugin: FrontendPluginModule = {
      /** Registers a request editor preset through the frontend plugin host. */
      register(context) {
        context.register("request.content", {
          id: "yaml",
          label: { default: "YAML" },
          mediaTypes: ["application/yaml", "*+yaml"],
          createBody: (previous) => ({
            kind: "text",
            contentType: "application/yaml",
            text: previous.kind === "text" ? previous.text : "",
          }),
          isDefaultFor: () => false,
          effectiveContentType: (body) =>
            body.kind === "text" ? body.contentType : null,
          mountEditor: (container, editor) => {
            /** Maps canonical request state to generic editor options. */
            const optionsFor = (current: typeof editor) => ({
              document: current.body.kind === "text" ? current.body.text : "",
              label: "YAML request body",
              onChange: (text: string) =>
                current.updateBody({
                  kind: "text",
                  contentType: "application/yaml",
                  text,
                }),
            });
            const handle = editor.ui.mountCodeEditor(
              container,
              optionsFor(editor),
            );
            return {
              /** Forwards host lifecycle updates to the mounted mechanism. */
              update(current) {
                handle.update(optionsFor(current));
              },
              /** Releases the mounted test mechanism. */
              destroy() {
                handle.destroy();
              },
            };
          },
        });
      },
    };
    const runtime = createTestFrontendPluginRuntime();
    runtime.plugins.install(yamlManifest, yamlPlugin, "user");
    const registry = runtime.requestContent;

    expect(
      registry.resolveBody({
        kind: "text",
        contentType: "application/example+yaml",
        text: "value: true",
      }).id,
    ).toBe("example.yaml/yaml");
    expect(typeof registry.require("example.yaml/yaml").mountEditor).toBe(
      "function",
    );
    expect(runtime.plugins.has("example.yaml")).toBe(true);
    expect(runtime.requestContent.list()[0]?.id).toBe("example.yaml/yaml");
    expect(registry.get("yaml")).toBeUndefined();

    const alternateManifest: PluginPackageManifest<"frontend"> = {
      ...yamlManifest,
      id: "example.alternate-yaml",
      name: "Alternate YAML content",
      weight: 5,
    };
    const alternatePlugin: FrontendPluginModule = {
      /** Reuses a local contribution name without colliding across packages. */
      register(context) {
        const contribution = registry.require("example.yaml/yaml");
        context.register("request.content", {
          ...contribution,
          id: "yaml",
          mediaTypes: [],
        });
      },
    };
    runtime.plugins.install(alternateManifest, alternatePlugin, "user");
    expect(registry.get("example.alternate-yaml/yaml")).toBeDefined();
  });
});
