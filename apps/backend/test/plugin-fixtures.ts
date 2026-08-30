import { HarImportProvider } from "../../../plugins/har-import/src/har-provider.js";
import { OpenApiJsonImportProvider } from "../../../plugins/openapi-import/src/openapi-json-provider.js";
import { ImportProviderRegistry } from "../src/imports/import-provider-registry.js";

/** Creates the built-in import capability set for isolated service tests. */
export function createImportProviderRegistry(): ImportProviderRegistry {
  return new ImportProviderRegistry([
    new OpenApiJsonImportProvider(),
    new HarImportProvider(),
  ]);
}
