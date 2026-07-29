import { parseArgs } from "node:util";

import { loadProxyConfiguration } from "./config.js";
import { createProxyServer } from "./transport/server.js";

const { values } = parseArgs({
  options: {
    config: {
      type: "string",
      default: "/etc/apinteract/proxy.yaml",
    },
  },
});

const configuration = await loadProxyConfiguration(values.config);
const server = createProxyServer(configuration);

let stopping: Promise<void> | undefined;

/** Stops the proxy listener and records shutdown failure exactly once. */
const stop = (): Promise<void> => {
  stopping ??= server.close().catch((cause: unknown) => {
    server.log.error({ err: cause }, "Proxy shutdown failed");
    process.exitCode = 1;
  });
  return stopping;
};

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

await server.listen(configuration.server);
