import type { PluginRegistrationContext } from "@apinteract/plugin-api";
import type { BackendPluginProviders } from "@apinteract/plugin-api/backend";

import { HarImportProvider } from "./har-provider.js";

/** Registers the HAR request and captured-response import implementation. */
export function register(
  context: PluginRegistrationContext<BackendPluginProviders>,
): void {
  context.register("request.import", new HarImportProvider());
}
