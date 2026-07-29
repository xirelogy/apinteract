import { createServer } from "node:http";

const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const payload = JSON.stringify({
      method: request.method,
      url: request.url,
      verification: request.headers["x-aio-verification"] ?? null,
      body,
    });
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "X-AIO-Fixture": "verified",
    });
    response.end(payload);
  });
});

/** Closes the deterministic AIO target fixture after pending connections drain. */
const stop = () => server.close();

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
server.listen(8090, "0.0.0.0");
