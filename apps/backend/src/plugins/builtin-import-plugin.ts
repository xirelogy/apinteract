import type { BackendPlugin } from "@apinteract/plugin-api/backend";

import { HarImportProvider } from "../imports/har-provider.js";
import { OpenApiJsonImportProvider } from "../imports/openapi-json-provider.js";

/** Installs APInteract's built-in OpenAPI and HAR request import adapters. */
export const builtinImportPlugin: BackendPlugin = {
  manifest: {
    apiVersion: 1,
    id: "apinteract.import",
    name: "APInteract import support",
    version: "1.0.0",
    target: "backend",
  },
  /** Registers the built-in import adapters without starting service work. */
  register(context) {
    context.register("request.import", new OpenApiJsonImportProvider());
    context.register("request.import", new HarImportProvider());
  },
};
