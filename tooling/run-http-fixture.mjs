import { createServer } from "node:http";

const host = process.env.APINTERACT_FIXTURE_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.APINTERACT_FIXTURE_PORT ?? "8090", 10);
const pixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const oversizedImageBytes = 16 * 1024 * 1024 + 1;

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
  if (request.method === "POST" && request.url?.startsWith("/echo?")) {
    void handleEcho(request, response);
    return;
  }
  if (request.method === "GET" && request.url === "/response/xml") {
    sendFixtureResponse(
      response,
      "application/xml; charset=utf-8",
      '<root>\n  <item id="1">value</item>\n</root>',
    );
    return;
  }
  if (request.method === "GET" && request.url === "/response/json") {
    sendFixtureResponse(
      response,
      "application/json; charset=utf-8",
      JSON.stringify({ message: "Structured fixture response." }),
    );
    return;
  }
  if (request.method === "GET" && request.url === "/response/html") {
    sendFixtureResponse(
      response,
      "text/html; charset=utf-8",
      '<main><h1>Fixture preview</h1><script>window.parent.fixtureScriptRan=true</script><img src="http://127.0.0.1:8090/preview-probe"></main>',
    );
    return;
  }
  if (request.method === "GET" && request.url === "/response/image") {
    sendFixtureResponse(response, "image/png", pixelPng);
    return;
  }
  if (request.method === "GET" && request.url === "/response/invalid-image") {
    sendFixtureResponse(response, "image/png", "not a png");
    return;
  }
  if (request.method === "GET" && request.url === "/response/large-image") {
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": oversizedImageBytes,
    });
    response.end(Buffer.alloc(oversizedImageBytes));
    return;
  }
  if (request.method === "GET" && request.url === "/response/binary") {
    sendFixtureResponse(
      response,
      "application/octet-stream",
      Buffer.from([0x00, 0xff, 0x10, 0x80]),
    );
    return;
  }
  if (request.method === "GET" && request.url === "/preview-probe") {
    sendFixtureResponse(response, "text/plain", "preview leaked a request");
    return;
  }

  response.writeHead(404, {
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("Not found");
}

/** Sends one complete deterministic body with matching representation metadata. */
function sendFixtureResponse(response, contentType, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  setTimeout(() => {
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": bytes.byteLength,
    });
    response.end(bytes);
  }, 150);
}

/** Echoes request semantics after a delay so running response UI is observable. */
async function handleEcho(request, response) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const body = JSON.stringify({
    method: request.method,
    query: [...url.searchParams.entries()],
    requestHeader: request.headers["x-fixture-request"] ?? null,
    inheritedHeader: request.headers["x-inherited"] ?? null,
    body: Buffer.concat(chunks).toString("utf8"),
  });
  response.writeHead(201, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-fixture-response": "echoed",
  });
  response.end(body);
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
