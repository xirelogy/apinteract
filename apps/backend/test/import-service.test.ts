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
                  headers: [{ name: "Authorization", value: "Bearer second" }],
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
        selectedItemIds: [plan.requests[1]!.itemId],
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
        targetUrl: "https://example.test/two",
        capturedExchange: {
          source: "har",
          status: 204,
          body: "",
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
      expect(reopened.capturedExchange?.status).toBe(204);
      const secret = await database.db
        .selectFrom("variable_secrets")
        .select("payload")
        .executeTakeFirstOrThrow();
      expect(secret.payload).toBe("Bearer second");
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
          info: {
            title: "Secured API",
            summary: "Secured operations",
            description: "# Secured API notes",
            version: "1",
          },
          servers: [
            {
              url: "https://primary.example.test",
              description: "Primary production endpoint.",
            },
          ],
          components: {
            securitySchemes: {
              bearerAuth: {
                type: "http",
                scheme: "bearer",
                description: "Bearer access token",
              },
            },
          },
          security: [{ bearerAuth: [] }],
          paths: {
            "/profile": {
              summary: "Profile resource",
              description: "Operations on the active profile.",
              get: {
                operationId: "getProfile",
                summary: "Get profile",
                description: "Returns the active profile.",
                parameters: [
                  {
                    name: "expand",
                    in: "query",
                    description: "Related profile data to include",
                    schema: { type: "string" },
                  },
                ],
                responses: {},
              },
            },
            "/admin": {
              get: {
                operationId: "getAdmin",
                servers: [{ url: "https://admin.example.test" }],
                responses: {},
              },
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

      const importedPathCollectionId = result.requests[0]!.parentCollectionId;
      if (importedPathCollectionId === null) {
        throw new Error("Expected an imported path collection");
      }
      expect(importedPathCollectionId).not.toBe(result.collectionId);
      await expect(
        requests.getCollection(userId, result.collectionId),
      ).resolves.toMatchObject({
        description: "Secured operations",
        notes: "# Secured API notes",
      });
      const importedPathCollection = await requests.getCollection(
        userId,
        importedPathCollectionId,
      );
      expect(importedPathCollection).toMatchObject({
        description: "Profile resource",
        notes: "Operations on the active profile.",
      });
      if (importedPathCollection.parentCollectionId === null) {
        throw new Error("Expected an imported server collection");
      }
      await expect(
        requests.getCollection(
          userId,
          importedPathCollection.parentCollectionId,
        ),
      ).resolves.toMatchObject({ notes: "Primary production endpoint." });
      expect(result.requests[0]).toMatchObject({
        description: "Get profile",
        notes: "Returns the active profile.",
        query: [
          expect.objectContaining({
            name: "expand",
            description: "Related profile data to include",
          }),
        ],
      });
      const profile = await variables.get(
        userId,
        "collection",
        result.collectionId,
      );
      expect(profile.variables).toEqual([
        expect.objectContaining({
          name: "bearerAuth",
          kind: "secret",
          description: "Bearer access token",
          hasValue: false,
          secretVersion: 1,
        }),
      ]);
      expect(
        (await variables.get(userId, "collection", importedPathCollectionId))
          .variables,
      ).toEqual([]);
      const requestProfile = await variables.get(
        userId,
        "request",
        result.requests[0]!.requestId,
      );
      expect(requestProfile.variables).toEqual([]);
      const inheritedSecret = requestProfile.inheritedVariables.find(
        (entry) => entry.variable.name === "bearerAuth",
      );
      expect(inheritedSecret).toMatchObject({
        variable: { name: "bearerAuth", kind: "secret" },
        source: {
          scope: "collection",
          scopeId: result.collectionId,
        },
      });
      const secret = await database.db
        .selectFrom("variable_secrets")
        .select("payload")
        .executeTakeFirstOrThrow();
      expect(secret.payload).toBeNull();
      expect(
        await database.db
          .selectFrom("workspace_tree_nodes")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: 4 });
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
