import { createRequire } from "node:module";

const packageManifest = createRequire(import.meta.url)("../package.json") as {
  readonly version: string;
};

/** Backend application version published by the package manifest. */
export const BACKEND_APPLICATION_VERSION = packageManifest.version;

/** Default identity included in target requests that omit User-Agent. */
export const DEFAULT_BACKEND_USER_AGENT = `APInteract/${BACKEND_APPLICATION_VERSION}`;
