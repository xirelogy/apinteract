import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { EnvironmentService } from "../src/environments/environment-service.js";
import { createEntityId, idToBytes } from "../src/foundation/id.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import { RequestService } from "../src/requests/request-service.js";
import { VariableService } from "../src/variables/variable-service.js";
import { VariableProfileConflictError } from "../src/variables/variable-profile-store.js";
import {
  AccessDeniedError,
  ResourceNotFoundError,
  WorkspaceService,
} from "../src/workspaces/workspace-service.js";

describe("persisted variable scopes", () => {
  it("merges every scope, redacts secrets, and snapshots profile evidence", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-variables-"));
    const database = await SqliteDatabase.open(
      join(rootPath, "database.sqlite"),
    );
    try {
      const userId = createEntityId();
      const viewerId = createEntityId();
      const sessionId = createEntityId();
      const now = Date.now();
      await database.db
        .insertInto("users")
        .values([
          {
            id: idToBytes(userId),
            status: "active",
            username: "variable-test",
            display_name: "Variable Test",
            is_instance_admin: 0,
            created_at: now,
            deleted_at: null,
          },
          {
            id: idToBytes(viewerId),
            status: "active",
            username: "variable-viewer",
            display_name: "Variable Viewer",
            is_instance_admin: 0,
            created_at: now,
            deleted_at: null,
          },
        ])
        .execute();
      await database.db
        .insertInto("sessions")
        .values({
          id: idToBytes(sessionId),
          user_id: idToBytes(userId),
          family_id: idToBytes(createEntityId()),
          status: "active",
          created_at: now,
          last_seen_at: now,
          absolute_expires_at: now + 60_000,
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
      const workspace = await workspaces.create(userId, "Variable workspace");
      await database.db
        .insertInto("workspace_memberships")
        .values({
          workspace_id: idToBytes(workspace.workspaceId),
          user_id: idToBytes(viewerId),
          role: "viewer",
          created_at: now,
        })
        .execute();
      const root = await requests.createCollection(
        userId,
        workspace.workspaceId,
        null,
        "Root",
      );
      const leaf = await requests.createCollection(
        userId,
        workspace.workspaceId,
        root.nodeId,
        "Leaf",
      );
      const request = await requests.createRequest(
        userId,
        workspace.workspaceId,
        leaf.nodeId,
        "Scoped request",
        "GET",
        "<<base_url>>/resource",
        [],
        [
          { name: "X-Collection", value: "<<collection_only>>", enabled: true },
          { name: "Authorization", value: "<<secret_alias>>", enabled: true },
        ],
        "",
      );
      const workspaceProfile = await variables.update(
        userId,
        "workspace",
        workspace.workspaceId,
        0,
        [
          { name: "base_url", kind: "value", value: "https://workspace.test" },
          { name: "workspace_only", kind: "value", value: "workspace" },
          { name: "token", kind: "secret", value: "super-secret" },
        ],
      );
      await variables.update(userId, "collection", root.nodeId, 0, [
        { name: "base_url", kind: "value", value: "https://root.test" },
        { name: "collection_only", kind: "value", value: "root" },
      ]);
      await variables.update(userId, "collection", leaf.nodeId, 0, [
        { name: "collection_only", kind: "value", value: "leaf" },
        { name: "blocked", kind: "unset" },
      ]);
      const environment = await environments.create(
        userId,
        workspace.workspaceId,
        "Development",
        [
          {
            name: "base_url",
            kind: "value",
            value: "https://environment.test",
          },
          { name: "environment_only", kind: "value", value: "environment" },
        ],
      );
      await environments.select(
        userId,
        sessionId,
        workspace.workspaceId,
        environment.environmentId,
      );
      const requestProfile = await variables.update(
        userId,
        "request",
        request.requestId,
        0,
        [
          { name: "base_url", kind: "value", value: "https://request.test" },
          { name: "secret_alias", kind: "alias", target: "token" },
        ],
      );

      await expect(
        variables.previewVariables(
          userId,
          sessionId,
          workspace.workspaceId,
          leaf.nodeId,
          null,
          ["base_url"],
        ),
      ).resolves.toMatchObject({
        previews: [
          {
            name: "base_url",
            value: "https://root.test",
            source: { scope: "collection", scopeName: "Root" },
          },
        ],
      });

      expect(workspaceProfile.variables).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "token",
            kind: "secret",
            hasValue: true,
            secretVersion: 1,
          }),
        ]),
      );
      expect(JSON.stringify(workspaceProfile)).not.toContain("super-secret");
      await expect(
        variables.get(viewerId, "workspace", workspace.workspaceId),
      ).resolves.toMatchObject({ revision: 1 });
      await expect(
        variables.update(
          viewerId,
          "workspace",
          workspace.workspaceId,
          workspaceProfile.revision,
          [],
        ),
      ).rejects.toBeInstanceOf(AccessDeniedError);

      const foreignWorkspace = await workspaces.create(
        viewerId,
        "Foreign workspace",
      );
      const foreignCollection = await requests.createCollection(
        viewerId,
        foreignWorkspace.workspaceId,
        null,
        "Foreign collection",
      );
      await expect(
        variables.previewVariables(
          userId,
          sessionId,
          workspace.workspaceId,
          foreignCollection.nodeId,
          null,
          ["workspace_only"],
        ),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);

      const preview = await variables.previewVariables(
        userId,
        sessionId,
        workspace.workspaceId,
        leaf.nodeId,
        request.requestId,
        ["base_url", "collection_only", "workspace_only", "secret_alias"],
      );
      expect(
        preview.previews.map((item) => ({
          name: item.name,
          value: item.value,
          effectiveKind: item.effectiveKind,
          secretVersion: item.secretVersion,
          sourceScope: item.source?.scope ?? null,
          sourceName: item.source?.scopeName ?? null,
        })),
      ).toEqual([
        {
          name: "base_url",
          value: "https://request.test",
          effectiveKind: "value",
          secretVersion: null,
          sourceScope: "request",
          sourceName: "Scoped request",
        },
        {
          name: "collection_only",
          value: "leaf",
          effectiveKind: "value",
          secretVersion: null,
          sourceScope: "collection",
          sourceName: "Leaf",
        },
        {
          name: "workspace_only",
          value: "workspace",
          effectiveKind: "value",
          secretVersion: null,
          sourceScope: "workspace",
          sourceName: "Variable workspace",
        },
        {
          name: "secret_alias",
          value: null,
          effectiveKind: "secret",
          secretVersion: 1,
          sourceScope: "request",
          sourceName: "Scoped request",
        },
      ]);
      expect(JSON.stringify(preview)).not.toContain("super-secret");

      const prepared = await requests.prepareExecution(
        userId,
        sessionId,
        request.requestId,
      );
      expect(prepared.request.targetUrl).toBe("https://request.test/resource");
      expect(prepared.request.headers).toEqual([
        {
          name: "X-Collection",
          value: "leaf",
          enabled: true,
          mode: "override",
        },
        {
          name: "Authorization",
          value: "super-secret",
          enabled: true,
          mode: "override",
        },
      ]);
      const execution = await database.db
        .selectFrom("executions")
        .select("snapshot_json")
        .where("id", "=", idToBytes(prepared.executionId))
        .executeTakeFirstOrThrow();
      expect(execution.snapshot_json).not.toContain("super-secret");
      const snapshot = JSON.parse(execution.snapshot_json) as {
        readonly variableProfiles: readonly {
          readonly scope: string;
          readonly scopeId: string;
          readonly revision: number;
        }[];
      };
      expect(snapshot.variableProfiles).toEqual([
        { scope: "workspace", scopeId: workspace.workspaceId, revision: 1 },
        {
          scope: "environment",
          scopeId: environment.environmentId,
          revision: 0,
        },
        { scope: "collection", scopeId: root.nodeId, revision: 1 },
        { scope: "collection", scopeId: leaf.nodeId, revision: 1 },
        { scope: "request", scopeId: request.requestId, revision: 1 },
      ]);

      const baseVariable = requestProfile.variables.find(
        (variable) => variable.name === "base_url",
      );
      expect(baseVariable).toBeDefined();
      await expect(
        variables.update(
          userId,
          "request",
          request.requestId,
          requestProfile.revision,
          [
            {
              variableId: baseVariable!.variableId,
              name: "base_url",
              kind: "unset",
            },
          ],
        ),
      ).rejects.toBeInstanceOf(VariableProfileConflictError);
    } finally {
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
