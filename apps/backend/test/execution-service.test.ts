import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { EnvironmentService } from "../src/environments/environment-service.js";
import { LocalBlobStore } from "../src/blobs/local-blob-store.js";
import {
  ExecutionService,
  type ExecutionEvent,
} from "../src/executions/execution-service.js";
import { createEntityId, idToBytes } from "../src/foundation/id.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import type { ProxyClient } from "../src/proxy/proxy-client.js";
import { RequestService } from "../src/requests/request-service.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";

describe("ExecutionService shutdown", () => {
  it("drains active proxy work and rejects new starts", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-execution-"));
    const database = await SqliteDatabase.open(
      join(rootPath, "database.sqlite"),
    );
    /** Releases the controlled proxy response during the drain assertion. */
    let releaseProxy: () => void = () => undefined;

    try {
      const userId = createEntityId();
      await database.db
        .insertInto("users")
        .values({
          id: idToBytes(userId),
          status: "active",
          username: "execution-test",
          display_name: "Execution Test",
          is_instance_admin: 0,
          created_at: Date.now(),
          deleted_at: null,
        })
        .execute();

      const audit = new AuditService(database.db, join(rootPath, "audit"));
      const blobs = new LocalBlobStore(
        join(rootPath, "blobs"),
        join(rootPath, "blob-staging"),
      );
      await blobs.initialize();
      const workspaces = new WorkspaceService(database.db, audit);
      const environments = new EnvironmentService(
        database.db,
        workspaces,
        audit,
      );
      const requests = new RequestService(
        database.db,
        workspaces,
        environments,
        audit,
      );
      const workspace = await workspaces.create(userId, "Workspace");
      const request = await requests.createRequest(
        userId,
        workspace.workspaceId,
        null,
        "Slow request",
        "GET",
        "https://example.test/slow",
        [],
        [],
        "",
      );
      const proxyBarrier = new Promise<void>((resolvePromise) => {
        releaseProxy = resolvePromise;
      });
      const responseBody = Buffer.from("completed while draining");
      const proxy = {
        execute: async (
          _idempotencyKey: string,
          _method: string,
          _url: string,
          _headers: readonly unknown[],
          _body: Buffer,
          sink: {
            responseHead(value: unknown): Promise<void>;
            body(value: Buffer): Promise<void>;
            complete(value: unknown): Promise<void>;
          },
        ) => {
          await sink.responseHead({
            type: "response_head",
            status: 200,
            headers: [{ name: "content-type", value: "text/plain" }],
            httpVersion: "HTTP/1.1",
          });
          await proxyBarrier;
          await sink.body(responseBody);
          await sink.complete({
            type: "complete",
            bodyBytes: responseBody.byteLength,
            bodySha256: createHash("sha256").update(responseBody).digest("hex"),
          });
        },
      } as unknown as ProxyClient;
      const executions = new ExecutionService(
        database.db,
        requests,
        workspaces,
        proxy,
        blobs,
        audit,
      );
      const events: ExecutionEvent[] = [];

      const sessionId = createEntityId();
      await executions.start(userId, sessionId, request.requestId, (event) =>
        events.push(event),
      );
      let drained = false;
      const closing = executions.close().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);

      releaseProxy();
      await closing;
      expect(events.at(-1)?.type).toBe("execution.completed");
      await expect(
        executions.startTemporary(
          userId,
          sessionId,
          workspace.workspaceId,
          null,
          {
            method: "GET",
            targetUrl: "https://example.test/rejected",
            query: [],
            headers: [],
            body: "",
          },
          () => undefined,
        ),
      ).rejects.toThrow(/unavailable during shutdown/u);
    } finally {
      releaseProxy();
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
