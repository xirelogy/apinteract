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

/** Stops accepting requests and closes application resources once. */
const stop = async (): Promise<void> => {
  await server.close();
};

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

await server.listen(configuration.server);
