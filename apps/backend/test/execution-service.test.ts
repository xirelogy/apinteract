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
  safeUtf8Preview,
  type ExecutionEvent,
} from "../src/executions/execution-service.js";
import { createEntityId, idToBytes } from "../src/foundation/id.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import type { ProxyClient } from "../src/proxy/proxy-client.js";
import { RequestService } from "../src/requests/request-service.js";
import { ScriptService } from "../src/scripting/script-service.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";
import { VariableService } from "../src/variables/variable-service.js";
import { DEFAULT_BACKEND_USER_AGENT } from "../src/version.js";

describe("response preview evidence", () => {
  it("retains format-neutral UTF-8 and rejects malformed or unsafe text", () => {
    expect(safeUtf8Preview(Buffer.from("value: true", "utf8"))).toBe(
      "value: true",
    );
    expect(safeUtf8Preview(Buffer.from([0xc3, 0x28]))).toBeUndefined();
    expect(
      safeUtf8Preview(Buffer.from("value\u0000true", "utf8")),
    ).toBeUndefined();
  });
});

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
      const variables = new VariableService(
        database.db,
        workspaces,
        environments,
        audit,
      );
      const requests = new RequestService(
        database.db,
        workspaces,
        variables,
        audit,
      );
      const workspace = await workspaces.create(userId, "Workspace");
      await variables.update(userId, "workspace", workspace.workspaceId, 0, [
        {
          name: "test-host",
          kind: "value",
          value: "https://example.test",
        },
      ]);
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
      const variables = new VariableService(
        database.db,
        workspaces,
        environments,
        audit,
      );
      const requests = new RequestService(
        database.db,
        workspaces,
        variables,
        audit,
      );
      const workspace = await workspaces.create(userId, "Workspace");
      await variables.update(userId, "workspace", workspace.workspaceId, 0, [
        {
          name: "test-host",
          kind: "value",
          value: "https://example.test",
        },
        { name: "token", kind: "secret", value: "top-secret" },
      ]);
      const collection = await requests.createCollection(
        userId,
        workspace.workspaceId,
        null,
        "Automation",
      );
      const environment = await environments.create(
        userId,
        workspace.workspaceId,
        "Development",
        [],
      );
      const sessionId = createEntityId();
      const sessionCreatedAt = Date.now();
      await database.db
        .insertInto("sessions")
        .values({
          id: idToBytes(sessionId),
          user_id: idToBytes(userId),
          family_id: idToBytes(createEntityId()),
          status: "active",
          created_at: sessionCreatedAt,
          last_seen_at: sessionCreatedAt,
          absolute_expires_at: sessionCreatedAt + 60_000,
        })
        .execute();
      await environments.select(
        userId,
        sessionId,
        workspace.workspaceId,
        environment.environmentId,
      );
      const request = await requests.createRequest(
        userId,
        workspace.workspaceId,
        collection.nodeId,
        "Scripted request",
        "GET",
        "<<test-host>>/test",
        [],
        [
          {
            name: "Authorization",
            value: "Bearer <<token>>",
            enabled: true,
          },
        ],
        '{"token":"<<token>>"}',
        `
          asdk.request.setMethod("POST");
          asdk.request.headers.set("X-Scripted", "yes");
          asdk.local.set("prepared", "yes");
          asdk.log.info("prepared request", {
            url: asdk.request.url.get(),
          });
        `,
        `
          asdk.test("response body", () => {
            asdk.assert.equal(asdk.response.status, 201);
            asdk.assert.match(asdk.response.body.text(), /created/);
            asdk.assert.equal(asdk.local.get("prepared"), "yes");
          });
          asdk.log.info("checked response", {
            url: asdk.request.url.get(),
          });
          const payload = JSON.parse(asdk.response.body.text());
          asdk.variables.set("createdResult", String(payload.created), {
            scope: "workspace",
          });
          asdk.variables.setSecret("nextToken", "response-token", {
            scope: "request",
          });
          asdk.variables.set("collectionResult", "ready", {
            scope: "parent-collection",
          });
          asdk.variables.setSecret("environmentToken", "environment-secret", {
            scope: "selected-environment",
          });
        `,
      );
      const responseBody = Buffer.from('{"created":true}');
      let sentMethod = "";
      let sentUrl = "";
      let chainedUrl = "";
      let chainedAuthorization = "";
      let sentBody: Uint8Array = new Uint8Array();
      let sentHeaders: readonly {
        readonly name: string;
        readonly value: string;
      }[] = [];
      const proxy = {
        execute: async (
          _idempotencyKey: string,
          method: string,
          url: string,
          headers: readonly { readonly name: string; readonly value: string }[],
          body: Buffer,
          sink: {
            responseHead(value: unknown): Promise<void>;
            body(value: Buffer): Promise<void>;
            complete(value: unknown): Promise<void>;
          },
        ) => {
          if (url.endsWith("/unavailable")) {
            throw new Error("The proxy is unavailable");
          }
          if (url === "https://example.test/test") {
            sentMethod = method;
            sentUrl = url;
            sentHeaders = headers;
            sentBody = body;
          }
          if (url === "https://example.test/true") {
            chainedUrl = url;
            chainedAuthorization =
              headers.find(
                (header) => header.name.toLowerCase() === "authorization",
              )?.value ?? "";
          }
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
        { variables },
      );
      const events: ExecutionEvent[] = [];
      /** Releases the chained request only after the producer committed its values. */
      let resolveFirstCompletion: () => void = () => undefined;
      const firstCompletion = new Promise<void>((resolvePromise) => {
        resolveFirstCompletion = resolvePromise;
      });

      await executions.start(userId, sessionId, request.requestId, (event) => {
        events.push(event);
        if (event.type === "execution.completed") resolveFirstCompletion();
      });
      await firstCompletion;
      const chainedRequest = await requests.createRequest(
        userId,
        workspace.workspaceId,
        collection.nodeId,
        "Chained consumer",
        "GET",
        "https://example.test/<<createdResult>>",
        [],
        [
          {
            name: "Authorization",
            value: "Bearer <<environmentToken>>",
            enabled: true,
          },
        ],
        "",
      );
      await executions.start(
        userId,
        sessionId,
        chainedRequest.requestId,
        () => undefined,
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
      const transportFailingRequest = await requests.createRequest(
        userId,
        workspace.workspaceId,
        null,
        "Failing transport without scripts",
        "GET",
        "https://example.test/unavailable",
        [],
        [],
        "",
        "",
        "",
      );
      const transportFailingEvents: ExecutionEvent[] = [];
      await executions.start(
        userId,
        createEntityId(),
        transportFailingRequest.requestId,
        (event) => transportFailingEvents.push(event),
      );
      await executions.close();

      expect(sentMethod).toBe("POST");
      expect(sentUrl).toBe("https://example.test/test");
      expect(Buffer.from(sentBody).toString("utf8")).toBe(
        '{"token":"top-secret"}',
      );
      expect(sentHeaders).toContainEqual({
        name: "Authorization",
        value: "Bearer top-secret",
      });
      expect(sentHeaders).toContainEqual({ name: "X-Scripted", value: "yes" });
      expect(chainedUrl).toBe("https://example.test/true");
      expect(chainedAuthorization).toBe("Bearer environment-secret");
      expect(sentHeaders).toContainEqual({
        name: "User-Agent",
        value: DEFAULT_BACKEND_USER_AGENT,
      });
      const terminal = events.at(-1);
      expect(terminal?.type).toBe("execution.completed");
      expect(terminal?.payload).toMatchObject({
        outgoingRequest: {
          method: "POST",
          url: { value: "https://example.test/test", redacted: false },
          headers: [
            {
              name: "Host",
              value: "example.test",
              redacted: false,
              derived: true,
            },
            {
              name: "Authorization",
              value: "[secret]",
              redacted: true,
              derived: false,
            },
            {
              name: "X-Scripted",
              value: "yes",
              redacted: false,
              derived: false,
            },
            {
              name: "User-Agent",
              value: DEFAULT_BACKEND_USER_AGENT,
              redacted: false,
              derived: false,
            },
          ],
          body: {
            value: "[secret]",
            encoding: "utf8",
            byteLength: 22,
            redacted: true,
            truncated: false,
          },
        },
        scriptLogs: [
          {
            sequence: 1,
            phase: "pre-request",
            message: "prepared request",
            fields: { url: "<<test-host>>/test" },
          },
          {
            sequence: 3,
            phase: "post-response",
            message: "checked response",
            fields: { url: "https://example.test/test" },
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
      expect(transportFailingEvents.at(-1)?.payload).toMatchObject({
        state: "failed",
        scriptLogs: [],
        scriptTests: [],
      });
      expect(transportFailingEvents.at(-1)?.payload).not.toHaveProperty(
        "scriptError",
      );
      const workspaceVariables = await variables.get(
        userId,
        "workspace",
        workspace.workspaceId,
        null,
      );
      expect(workspaceVariables.revision).toBe(2);
      expect(
        workspaceVariables.variables.find(
          (variable) => variable.name === "createdResult",
        ),
      ).toMatchObject({ name: "createdResult", kind: "value", value: "true" });
      expect(
        await variables.get(userId, "request", request.requestId, null),
      ).toMatchObject({
        revision: 1,
        variables: [{ name: "nextToken", kind: "secret", hasValue: true }],
      });
      expect(
        await variables.get(userId, "collection", collection.nodeId, null),
      ).toMatchObject({
        revision: 1,
        variables: [
          { name: "collectionResult", kind: "value", value: "ready" },
        ],
      });
      expect(
        await environments.get(userId, environment.environmentId),
      ).toMatchObject({
        revision: 1,
        variables: [
          { name: "environmentToken", kind: "secret", hasValue: true },
        ],
      });
      const persistedExecution = await database.db
        .selectFrom("executions")
        .select("script_result_json")
        .where("id", "=", idToBytes(events.at(-1)!.executionId))
        .executeTakeFirstOrThrow();
      const auditEvents = await database.db
        .selectFrom("audit_outbox")
        .select("event_json")
        .execute();
      expect(persistedExecution.script_result_json).not.toContain(
        "response-token",
      );
      expect(JSON.stringify(auditEvents)).not.toContain("response-token");
      expect(JSON.stringify(auditEvents)).not.toContain("environment-secret");
    } finally {
      await scripts.close();
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
