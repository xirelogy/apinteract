import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { LocalBlobStore } from "../src/blobs/local-blob-store.js";
import { CookieJarService } from "../src/cookies/cookie-jar-service.js";
import { EnvironmentService } from "../src/environments/environment-service.js";
import { RequestExchangeService } from "../src/exchanges/request-exchange-service.js";
import {
  ExecutionService,
  type ExecutionEvent,
  type ExecutionView,
} from "../src/executions/execution-service.js";
import { createEntityId, idToBytes } from "../src/foundation/id.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import type {
  ProxyClient,
  ProxyExecutionOptions,
  ProxyResponseSink,
} from "../src/proxy/proxy-client.js";
import { RequestService } from "../src/requests/request-service.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";
import { VariableService } from "../src/variables/variable-service.js";

interface ProxyCall {
  readonly idempotencyKey: string;
  readonly method: string;
  readonly url: string;
  readonly headers: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly body: Buffer;
  readonly options: ProxyExecutionOptions;
}

describe("redirect execution orchestration", () => {
  it("persists and exposes every independently executed hop", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-redirect-run-"));
    const database = await SqliteDatabase.open(
      join(rootPath, "database.sqlite"),
    );
    try {
      const userId = createEntityId();
      await database.db
        .insertInto("users")
        .values({
          id: idToBytes(userId),
          status: "active",
          username: "redirect-execution-test",
          display_name: "Redirect Execution Test",
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
      const calls: ProxyCall[] = [];
      const proxy = {
        execute: async (
          idempotencyKey: string,
          method: string,
          url: string,
          headers: readonly { readonly name: string; readonly value: string }[],
          body: Buffer,
          sink: ProxyResponseSink,
          _bodyPresent: boolean,
          options: ProxyExecutionOptions,
        ) => {
          const index = calls.length;
          calls.push({ idempotencyKey, method, url, headers, body, options });
          const responseBody = Buffer.from(index === 0 ? "redirect" : "final");
          await sink.responseHead({
            status: index === 0 ? 302 : 200,
            headers:
              index === 0
                ? [
                    { name: "Location", value: "/final?from=redirect" },
                    {
                      name: "Set-Cookie",
                      value: "redirect_session=accepted; Path=/; HttpOnly",
                    },
                  ]
                : [
                    { name: "Content-Type", value: "text/plain" },
                    {
                      name: "Set-Cookie",
                      value: "final_cookie=stored; Path=/; Max-Age=3600",
                    },
                  ],
            httpVersion: "HTTP/1.1",
            receivedAt: "2026-09-08T00:00:00.000Z",
          });
          await sink.body(responseBody);
          await sink.complete({
            bodyBytes: responseBody.byteLength,
            bodySha256: createHash("sha256").update(responseBody).digest("hex"),
            timings: { totalMs: 1 },
            transportMetadataCollected: false,
            transportMetadataUnavailableReason: "disabled",
            completedAt: "2026-09-08T00:00:00.001Z",
          });
        },
      } as unknown as ProxyClient;
      const cookies = new CookieJarService(database.db, workspaces, audit);
      const executions = new ExecutionService(
        database.db,
        requests,
        workspaces,
        proxy,
        blobs,
        audit,
        undefined,
        { cookies },
      );
      const events: ExecutionEvent[] = [];
      const savedRequest = await requests.createRequest(
        userId,
        workspace.workspaceId,
        null,
        "Redirected request",
        "POST",
        "https://example.test/start",
        [{ name: "initial", value: "one", enabled: true }],
        [
          {
            name: "Content-Type",
            value: "application/json",
            enabled: true,
          },
        ],
        "payload",
        "",
        "",
        "absolute",
        undefined,
        {
          redirectPolicy: { follow: true, maxRedirects: 2 },
        },
      );
      const sessionId = createEntityId();
      const running = await executions.start(
        userId,
        sessionId,
        savedRequest.requestId,
        (event) => events.push(event),
      );
      await executions.close();

      expect(calls).toHaveLength(2);
      expect(new Set(calls.map((call) => call.idempotencyKey)).size).toBe(2);
      expect(calls[0]).toMatchObject({
        method: "POST",
        url: "https://example.test/start?initial=one",
      });
      expect(calls[0]?.body.toString()).toBe("payload");
      expect(calls[1]).toMatchObject({
        method: "GET",
        url: "https://example.test/final?from=redirect",
      });
      expect(calls[1]?.body.byteLength).toBe(0);
      expect(calls[1]?.headers).not.toContainEqual(
        expect.objectContaining({ name: "Content-Type" }),
      );
      expect(calls[1]?.headers).toContainEqual({
        name: "Cookie",
        value: "redirect_session=accepted",
      });
      expect(calls[1]?.options.totalTimeoutMs).toBeLessThanOrEqual(
        calls[0]?.options.totalTimeoutMs ?? 0,
      );
      expect(calls[1]?.options.maxResponseBodyBytes).toBe(
        (calls[0]?.options.maxResponseBodyBytes ?? 0) -
          Buffer.byteLength("redirect"),
      );

      const terminal = events.at(-1)?.payload as ExecutionView;
      expect(events.at(-1)?.type).toBe("execution.completed");
      expect(terminal.executionId).not.toBe(running.executionId);
      expect(terminal.rootExecutionId).toBe(running.executionId);
      expect(terminal.exchangeSequence).toBe(1);
      expect(terminal.status).toBe(200);
      expect(terminal.bodyPreview).toBe("final");
      expect(terminal.redirectChain).toEqual([
        expect.objectContaining({
          exchangeId: running.executionId,
          sequence: 0,
          status: 302,
          final: false,
        }),
        expect.objectContaining({
          exchangeId: terminal.executionId,
          sequence: 1,
          status: 200,
          final: true,
        }),
      ]);

      const exchanges = new RequestExchangeService(
        database.db,
        workspaces,
        blobs,
      );
      const history = await exchanges.list(userId, savedRequest.requestId);
      expect(history[0]).toMatchObject({
        exchangeId: running.executionId,
        status: 200,
        state: "completed",
      });
      const source = await exchanges.getExecution(userId, running.executionId);
      expect(source.redirect).toMatchObject({
        outcome: "followed",
        destinationExecutionId: terminal.executionId,
      });
      expect(source.bodyPreview).toBe("redirect");
      const destination = await exchanges.getExecution(
        userId,
        terminal.executionId,
      );
      expect(destination.bodyPreview).toBe("final");
      expect(destination.redirectChain).toHaveLength(2);
      const jar = await cookies.getActive(
        userId,
        sessionId,
        workspace.workspaceId,
      );
      expect(jar.cookies.map((cookie) => cookie.name)).toEqual([
        "redirect_session",
        "final_cookie",
      ]);
    } finally {
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
