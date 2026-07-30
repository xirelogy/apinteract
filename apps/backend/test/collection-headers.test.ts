import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { EnvironmentService } from "../src/environments/environment-service.js";
import { createEntityId, idToBytes } from "../src/foundation/id.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import {
  CollectionProfileConflictError,
  RequestService,
  resolveHeaderLayers,
} from "../src/requests/request-service.js";
import {
  AccessDeniedError,
  ResourceNotFoundError,
  WorkspaceService,
} from "../src/workspaces/workspace-service.js";

describe("collection header inheritance", () => {
  it("overlays case-insensitive groups while preserving winning duplicates", () => {
    expect(
      resolveHeaderLayers([
        [
          { name: "X-Root", value: "root", enabled: true },
          { name: "X-Shared", value: "root", enabled: true },
        ],
        [
          { name: "x-shared", value: "child-1", enabled: true },
          { name: "X-SHARED", value: "child-2", enabled: true },
          { name: "X-Ignored", value: "disabled", enabled: false },
        ],
      ]),
    ).toEqual([
      { name: "X-Root", value: "root", enabled: true },
      { name: "x-shared", value: "child-1", enabled: true },
      { name: "X-SHARED", value: "child-2", enabled: true },
    ]);
  });

  it("persists profiles and snapshots resolved headers across three levels", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-headers-"));
    const database = await SqliteDatabase.open(
      join(rootPath, "database.sqlite"),
    );

    try {
      const userId = createEntityId();
      const foreignUserId = createEntityId();
      await database.db
        .insertInto("users")
        .values([
          {
            id: idToBytes(userId),
            status: "active",
            username: "header-test",
            display_name: "Header Test",
            is_instance_admin: 0,
            created_at: Date.now(),
            deleted_at: null,
          },
          {
            id: idToBytes(foreignUserId),
            status: "active",
            username: "foreign-header-test",
            display_name: "Foreign Header Test",
            is_instance_admin: 0,
            created_at: Date.now(),
            deleted_at: null,
          },
        ])
        .execute();
      const audit = new AuditService(database.db, join(rootPath, "audit"));
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
      const root = await requests.createCollection(
        userId,
        workspace.workspaceId,
        null,
        "Root",
      );
      const child = await requests.createCollection(
        userId,
        workspace.workspaceId,
        root.nodeId,
        "Child",
      );
      const leaf = await requests.createCollection(
        userId,
        workspace.workspaceId,
        child.nodeId,
        "Leaf",
      );
      const request = await requests.createRequest(
        userId,
        workspace.workspaceId,
        leaf.nodeId,
        "Inherited request",
        "GET",
        "https://example.test/headers",
        [],
        [
          { name: "X-Shared", value: "request", enabled: true },
          { name: "X-Local", value: "local", enabled: true },
          { name: "X-Root", value: "disabled", enabled: false },
        ],
        "",
      );

      expect(await requests.getCollection(userId, root.nodeId)).toMatchObject({
        collectionId: root.nodeId,
        parentCollectionId: null,
        headers: [],
        revision: 0,
      });
      const rootProfile = await requests.updateCollectionHeaders(
        userId,
        root.nodeId,
        0,
        [
          { name: "X-Root", value: "root", enabled: true },
          { name: "X-Shared", value: "root", enabled: true },
        ],
      );
      expect(rootProfile.revision).toBe(1);
      await requests.updateCollectionHeaders(userId, child.nodeId, 0, [
        { name: "x-shared", value: "child-1", enabled: true },
        { name: "X-SHARED", value: "child-2", enabled: true },
        { name: "X-Ignored", value: "disabled", enabled: false },
      ]);
      await requests.updateCollectionHeaders(userId, leaf.nodeId, 0, [
        { name: "X-Leaf", value: "leaf", enabled: true },
      ]);

      await expect(
        requests.getCollection(userId, leaf.nodeId),
      ).resolves.toMatchObject({
        effectiveHeaders: [
          { name: "X-Root", value: "root", enabled: true },
          { name: "x-shared", value: "child-1", enabled: true },
          { name: "X-SHARED", value: "child-2", enabled: true },
          { name: "X-Leaf", value: "leaf", enabled: true },
        ],
      });
      await expect(
        requests.get(userId, request.requestId),
      ).resolves.toMatchObject({
        parentCollectionId: leaf.nodeId,
        inheritedHeaders: [
          { name: "X-Root", value: "root", enabled: true },
          { name: "x-shared", value: "child-1", enabled: true },
          { name: "X-SHARED", value: "child-2", enabled: true },
          { name: "X-Leaf", value: "leaf", enabled: true },
        ],
      });

      await expect(
        requests.updateCollectionHeaders(userId, root.nodeId, 0, []),
      ).rejects.toBeInstanceOf(CollectionProfileConflictError);
      await expect(
        requests.getCollection(foreignUserId, root.nodeId),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(
        requests.updateCollectionHeaders(
          foreignUserId,
          root.nodeId,
          rootProfile.revision,
          [],
        ),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        requests.getCollection(userId, request.requestId),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);

      const prepared = await requests.prepareExecution(
        userId,
        createEntityId(),
        request.requestId,
      );
      expect(prepared.request.headers).toEqual([
        { name: "X-Root", value: "root", enabled: true },
        { name: "X-Leaf", value: "leaf", enabled: true },
        { name: "X-Shared", value: "request", enabled: true },
        { name: "X-Local", value: "local", enabled: true },
      ]);
      const execution = await database.db
        .selectFrom("executions")
        .select("snapshot_json")
        .where("id", "=", idToBytes(prepared.executionId))
        .executeTakeFirstOrThrow();
      const revision = await database.db
        .selectFrom("request_revisions")
        .select("content_json")
        .where("id", "=", idToBytes(prepared.revisionId!))
        .executeTakeFirstOrThrow();
      const executionSnapshot = JSON.parse(execution.snapshot_json) as {
        readonly headers: unknown;
      };
      const revisionSnapshot = JSON.parse(revision.content_json) as {
        readonly headers: unknown;
      };
      expect(executionSnapshot.headers).toEqual(prepared.request.headers);
      expect(revisionSnapshot.headers).toEqual(prepared.request.headers);
    } finally {
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
