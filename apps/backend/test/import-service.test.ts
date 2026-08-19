import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { EnvironmentService } from "../src/environments/environment-service.js";
import { createEntityId, idToBytes } from "../src/foundation/id.js";
import { ImportService } from "../src/imports/import-service.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import { RequestService } from "../src/requests/request-service.js";
import { VariableService } from "../src/variables/variable-service.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";

describe("ImportService", () => {
  it("rejects a selected HAR WebSocket request before persistence", async () => {
    const importRequests = vi.fn();
    const requestService = {
      importRequests,
    } as unknown as RequestService;
    const imports = new ImportService(requestService);
    const source = {
      name: "websocket.har",
      text: JSON.stringify({
        log: {
          version: "1.2",
          entries: [
            {
              request: {
                method: "GET",
                url: "wss://example.test/socket",
                headers: [],
              },
            },
          ],
        },
      }),
    };
    const plan = await imports.preview("har", source);

    await expect(
      imports.apply(createEntityId(), "har", source, {
        workspaceId: createEntityId(),
        parentCollectionId: null,
        collectionName: "WebSockets",
        selectedItemIds: [plan.requests[0]!.itemId],
        expectedSourceFingerprint: plan.sourceFingerprint,
      }),
    ).rejects.toMatchObject({ code: "import_plan_invalid" });
    expect(importRequests).not.toHaveBeenCalled();
  });

  it("atomically creates selected HAR requests and separate captures", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-import-"));
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
          username: "import-test",
          display_name: "Import Test",
          is_instance_admin: 0,
          created_at: Date.now(),
          deleted_at: null,
        })
        .execute();
      const audit = new AuditService(database.db, join(rootPath, "audit"));
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
      const imports = new ImportService(requests);
      const workspace = await workspaces.create(userId, "Workspace");
      const source = {
        name: "capture.har",
        text: JSON.stringify({
          log: {
            version: "1.2",
            entries: [
              {
                startedDateTime: "2025-02-01T00:00:00Z",
                request: {
                  method: "GET",
                  url: "https://example.test/one",
                  headers: [{ name: "Authorization", value: "Bearer private" }],
                },
                response: {
                  status: 200,
                  statusText: "OK",
                  headers: [{ name: "Content-Type", value: "text/plain" }],
                  content: { mimeType: "text/plain", text: "first" },
                },
              },
              {
                request: {
                  method: "GET",
                  url: "https://example.test/two",
                  headers: [],
                },
                response: {
                  status: 204,
                  statusText: "No Content",
                  headers: [],
                  content: { mimeType: "text/plain", text: "" },
                },
              },
            ],
          },
        }),
      };
      const plan = await imports.preview(null, source);

      const result = await imports.apply(userId, null, source, {
        workspaceId: workspace.workspaceId,
        parentCollectionId: null,
        collectionName: "Imported capture",
        selectedItemIds: [plan.requests[0]!.itemId],
        expectedSourceFingerprint: plan.sourceFingerprint,
      });

      expect(result.requests).toHaveLength(1);
      expect(
        await database.db
          .selectFrom("workspace_tree_nodes")
          .select("name")
          .where("id", "=", idToBytes(result.collectionId))
          .executeTakeFirstOrThrow(),
      ).toEqual({ name: "Imported capture" });
      expect(result.requests[0]).toMatchObject({
        parentCollectionId: result.collectionId,
        targetUrl: "https://example.test/one",
        capturedExchange: {
          source: "har",
          status: 200,
          body: "first",
        },
      });
      expect(
        await database.db
          .selectFrom("captured_exchanges")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: 1 });
      expect(
        await database.db
          .selectFrom("workspace_tree_nodes")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: 2 });
      const reopened = await requests.get(
        userId,
        result.requests[0]!.requestId,
      );
      expect(reopened.capturedExchange?.status).toBe(200);
      const secret = await database.db
        .selectFrom("variable_secrets")
        .select("payload")
        .executeTakeFirstOrThrow();
      expect(secret.payload).toBe("Bearer private");
    } finally {
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("persists OpenAPI credentials as unconfigured imported secrets", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-import-"));
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
          username: "openapi-import-test",
          display_name: "OpenAPI Import Test",
          is_instance_admin: 0,
          created_at: Date.now(),
          deleted_at: null,
        })
        .execute();
      const audit = new AuditService(database.db, join(rootPath, "audit"));
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
      const imports = new ImportService(requests);
      const workspace = await workspaces.create(userId, "Workspace");
      const source = {
        name: "secured-api.json",
        text: JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Secured API", version: "1" },
          components: {
            securitySchemes: {
              bearerAuth: { type: "http", scheme: "bearer" },
            },
          },
          security: [{ bearerAuth: [] }],
          paths: {
            "/profile": {
              get: { operationId: "getProfile", responses: {} },
            },
          },
        }),
      };
      const plan = await imports.preview("openapi-json", source);

      const result = await imports.apply(userId, "openapi-json", source, {
        workspaceId: workspace.workspaceId,
        parentCollectionId: null,
        collectionName: "Secured API",
        selectedItemIds: [plan.requests[0]!.itemId],
        expectedSourceFingerprint: plan.sourceFingerprint,
      });

      const profile = await variables.get(
        userId,
        "request",
        result.requests[0]!.requestId,
      );
      expect(profile.variables).toEqual([
        expect.objectContaining({
          name: "bearerAuth",
          kind: "secret",
          hasValue: false,
          secretVersion: 1,
        }),
      ]);
      const secret = await database.db
        .selectFrom("variable_secrets")
        .select("payload")
        .executeTakeFirstOrThrow();
      expect(secret.payload).toBeNull();
      await expect(
        variables.update(userId, "workspace", workspace.workspaceId, 0, [
          { name: "ordinarySecret", kind: "secret" },
        ]),
      ).rejects.toThrow("A new secret requires a value");
    } finally {
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
