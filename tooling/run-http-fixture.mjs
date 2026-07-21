import { createServer } from "node:http";

const host = process.env.APINTERACT_FIXTURE_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.APINTERACT_FIXTURE_PORT ?? "8090", 10);

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("APINTERACT_FIXTURE_PORT must be a valid TCP port");
}

const server = createServer(handleRequest);
server.listen(port, host, () => {
  process.stdout.write(`HTTP fixture listening on http://${host}:${port}\n`);
});

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

/** Serves deterministic responses used by local development and browser tests. */
function handleRequest(request, response) {
  if (request.method === "GET" && request.url === "/hello") {
    const body = JSON.stringify({
      message: "Hello from the APInteract fixture.",
    });
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
    return;
  }

  response.writeHead(404, {
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("Not found");
}

/** Stops the fixture after allowing active responses to finish. */
async function stop() {
  await new Promise((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) {
        resolve();
      } else {
        reject(cause);
      }
    });
  });
}
