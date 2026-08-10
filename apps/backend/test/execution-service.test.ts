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
import { ScriptService } from "../src/scripting/script-service.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";
import { VariableService } from "../src/variables/variable-service.js";

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
        new VariableService(database.db, workspaces, environments, audit),
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

  it("runs persisted pre-request and post-response scripts around proxy work", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-scripting-"));
    const database = await SqliteDatabase.open(
      join(rootPath, "database.sqlite"),
    );
    const scripts = new ScriptService();
    try {
      const userId = createEntityId();
      await database.db
        .insertInto("users")
        .values({
          id: idToBytes(userId),
          status: "active",
          username: "scripting-integration-test",
          display_name: "Scripting Integration Test",
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
        new VariableService(database.db, workspaces, environments, audit),
        audit,
      );
      const workspace = await workspaces.create(userId, "Workspace");
      const request = await requests.createRequest(
        userId,
        workspace.workspaceId,
        null,
        "Scripted request",
        "GET",
        "https://example.test/scripted",
        [],
        [],
        "",
        `
          asdk.request.setMethod("POST");
          asdk.request.headers.set("X-Scripted", "yes");
          asdk.local.set("prepared", "yes");
          asdk.log.info("prepared request");
        `,
        `
          asdk.test("response body", () => {
            asdk.assert.equal(asdk.response.status, 201);
            asdk.assert.match(asdk.response.body.text(), /created/);
            asdk.assert.equal(asdk.local.get("prepared"), "yes");
          });
          asdk.log.info("checked response");
        `,
      );
      const responseBody = Buffer.from('{"created":true}');
      let sentMethod = "";
      let sentHeaders: readonly {
        readonly name: string;
        readonly value: string;
      }[] = [];
      const proxy = {
        execute: async (
          _idempotencyKey: string,
          method: string,
          _url: string,
          headers: readonly { readonly name: string; readonly value: string }[],
          _body: Buffer,
          sink: {
            responseHead(value: unknown): Promise<void>;
            body(value: Buffer): Promise<void>;
            complete(value: unknown): Promise<void>;
          },
        ) => {
          sentMethod = method;
          sentHeaders = headers;
          await sink.responseHead({
            type: "response_head",
            status: 201,
            headers: [{ name: "content-type", value: "application/json" }],
            httpVersion: "HTTP/1.1",
          });
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
        scripts,
      );
      const events: ExecutionEvent[] = [];

      await executions.start(
        userId,
        createEntityId(),
        request.requestId,
        (event) => events.push(event),
      );
      const failingRequest = await requests.createRequest(
        userId,
        workspace.workspaceId,
        null,
        "Failing post script",
        "GET",
        "https://example.test/failing-script",
        [],
        [],
        "",
        "",
        'throw new Error("Visible post-response failure");',
      );
      const failingEvents: ExecutionEvent[] = [];
      await executions.start(
        userId,
        createEntityId(),
        failingRequest.requestId,
        (event) => failingEvents.push(event),
      );
      await executions.close();

      expect(sentMethod).toBe("POST");
      expect(sentHeaders).toContainEqual({ name: "X-Scripted", value: "yes" });
      const terminal = events.at(-1);
      expect(terminal?.type).toBe("execution.completed");
      expect(terminal?.payload).toMatchObject({
        scriptLogs: [
          {
            sequence: 1,
            phase: "pre-request",
            message: "prepared request",
          },
          {
            sequence: 3,
            phase: "post-response",
            message: "checked response",
          },
        ],
        scriptTests: [{ sequence: 2, name: "response body", status: "passed" }],
      });
      expect(failingEvents.at(-1)?.payload).toMatchObject({
        state: "completed",
        scriptError: {
          phase: "post-response",
          code: "runtime_error",
          message: "Visible post-response failure",
          line: 1,
        },
      });
    } finally {
      await scripts.close();
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
