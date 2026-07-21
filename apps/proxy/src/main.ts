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

/** Stops the proxy listener and releases process resources once. */
const stop = async (): Promise<void> => {
  await server.close();
};

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

await server.listen(configuration.server);
