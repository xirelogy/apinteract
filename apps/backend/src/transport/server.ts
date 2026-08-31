import { stat } from "node:fs/promises";

import staticFiles from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import type { Application } from "../bootstrap/application.js";
import type { BackendConfiguration } from "../config.js";
import { registerHttpRoutes } from "./http.js";
import { registerWebSocketRoute } from "./websocket.js";

/** Creates the backend server, routes, SPA hosting, and audit publisher lifecycle. */
export async function createBackendServer(
  application: Application,
  configuration: BackendConfiguration,
): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: "info",
      base: { component: "backend" },
    },
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000,
  });

  await registerHttpRoutes(server, application, configuration);
  await registerWebSocketRoute(server, application, configuration);

  if (await directoryExists(configuration.frontend.distPath)) {
    await server.register(staticFiles, {
      root: configuration.frontend.distPath,
      prefix: "/web-ui/",
      wildcard: false,
      index: "index.html",
      cacheControl: false,
      /** Gives the SPA shell and content-hashed assets distinct cache policies. */
      setHeaders(reply, path) {
        reply.raw.setHeader(
          "Cache-Control",
          path.split(/[/\\]/u).includes("assets")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      },
    });
    /** Redirects the un-slashed UI path to the static SPA root. */
    server.get("/web-ui", async (_request, reply) =>
      reply.redirect("/web-ui/"),
    );
    /** Sends the deployment origin to the only browser-facing application. */
    server.get("/", async (_request, reply) => reply.redirect("/web-ui/"));
  }

  const auditInterval = setInterval(() => {
    void application.audit.publishPending().catch((cause: unknown) => {
      server.log.error({ err: cause }, "Audit publication failed");
    });
  }, 1000);
  auditInterval.unref();

  server.addHook("onClose", async () => {
    clearInterval(auditInterval);
    await application.close();
  });
  return server;
}

/** Reports whether a configured static-content path is an existing directory. */
async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
