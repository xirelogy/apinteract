import type { PluginPackageManifest } from "@apinteract/plugin-api";
import type { FrontendPluginModule } from "@apinteract/plugin-api/frontend";

import * as basicHttpContent from "../../../plugins/basic-http-content/src/index";
import * as htmlPreview from "../../../plugins/html-preview/src/index";
import * as jsonContent from "../../../plugins/json-content/src/index";
import * as rasterImagePreview from "../../../plugins/raster-image-preview/src/index";
import * as xmlContent from "../../../plugins/xml-content/src/index";
import {
  createFrontendPluginRuntime,
  frontendPluginRuntime,
  type FrontendPluginRuntime,
} from "../src/app/plugins/frontend-plugin-host";

const builtinPlugins: readonly (readonly [
  PluginPackageManifest<"frontend">,
  FrontendPluginModule,
])[] = [
  [
    manifest("apinteract.basic-http-content", "Basic HTTP content", [
      "request.content",
      "response.content",
    ]),
    basicHttpContent,
  ],
  [
    manifest("apinteract.json-content", "JSON content", [
      "request.content",
      "response.content",
    ]),
    jsonContent,
  ],
  [
    manifest("apinteract.xml-content", "XML content", [
      "request.content",
      "response.content",
    ]),
    xmlContent,
  ],
  [
    manifest("apinteract.html-preview", "HTML response preview", [
      "response.content",
    ]),
    htmlPreview,
  ],
  [
    manifest("apinteract.raster-image-preview", "Raster image preview", [
      "response.content",
    ]),
    rasterImagePreview,
  ],
];

/** Creates an isolated runtime populated through built-in package contracts. */
export function createTestFrontendPluginRuntime(): FrontendPluginRuntime {
  const runtime = createFrontendPluginRuntime();
  installTestFrontendPlugins(runtime);
  return runtime;
}

/** Installs test package modules into the application singleton exactly once. */
export function installApplicationTestPlugins(): void {
  installTestFrontendPlugins(frontendPluginRuntime);
}

/** Installs each built-in test package into one empty runtime. */
function installTestFrontendPlugins(runtime: FrontendPluginRuntime): void {
  for (const [pluginManifest, pluginModule] of builtinPlugins) {
    if (!runtime.plugins.has(pluginManifest.id)) {
      runtime.plugins.install(pluginManifest, pluginModule, "built-in");
    }
  }
  runtime.plugins.validateCapabilities();
}

/** Creates canonical metadata for one frontend test package module. */
function manifest(
  id: string,
  name: string,
  providers: readonly ("request.content" | "response.content")[],
): PluginPackageManifest<"frontend"> {
  return {
    schemaVersion: 1,
    apiVersion: 2,
    id,
    name,
    version: "1.0.0",
    target: "frontend",
    entrypoint: "dist/index.mjs",
    providers,
  };
}
