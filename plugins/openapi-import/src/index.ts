import type { PluginRegistrationContext } from "@apinteract/plugin-api";
import type { BackendPluginProviders } from "@apinteract/plugin-api/backend";

import { OpenApiJsonImportProvider } from "./openapi-json-provider.js";

/** Registers the OpenAPI request and collection import implementation. */
export function register(
  context: PluginRegistrationContext<BackendPluginProviders>,
): void {
  context.register("request.import", new OpenApiJsonImportProvider());
}
