import { createRequire } from "node:module";

const packageManifest = createRequire(import.meta.url)("../package.json") as {
  readonly version: string;
};

/** Proxy application version published by the package manifest. */
export const PROXY_APPLICATION_VERSION = packageManifest.version;

/** Outbound identity used when a target request omits User-Agent. */
export const DEFAULT_PROXY_USER_AGENT = `apinteract-proxy/${PROXY_APPLICATION_VERSION}`;
