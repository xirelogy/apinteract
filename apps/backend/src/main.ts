import { parseArgs } from "node:util";

import { createApplication } from "./bootstrap/application.js";
import { loadBackendConfiguration } from "./config.js";
import { createBackendServer } from "./transport/server.js";

const { values } = parseArgs({
  options: {
    config: {
      type: "string",
      default: "/etc/apinteract/backend.yaml",
    },
  },
});

const configuration = await loadBackendConfiguration(values.config);
const application = await createApplication(configuration);
const server = await createBackendServer(application, configuration);

let stopping: Promise<void> | undefined;

/** Stops accepting requests, drains work, and records shutdown failure once. */
const stop = (): Promise<void> => {
  stopping ??= server.close().catch((cause: unknown) => {
    server.log.error({ err: cause }, "Backend shutdown failed");
    process.exitCode = 1;
  });
  return stopping;
};

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

await server.listen(configuration.server);
