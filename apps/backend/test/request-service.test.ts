import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { EnvironmentService } from "../src/environments/environment-service.js";
import { bytesToId, createEntityId, idToBytes } from "../src/foundation/id.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import {
  RequestService,
  TreeMoveInvalidError,
  TreeOrderConflictError,
} from "../src/requests/request-service.js";
import { VariableService } from "../src/variables/variable-service.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";

describe("RequestService draft updates", () => {
  it("keeps the current revision when normalized draft content is unchanged", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-request-"));
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
          username: "request-test",
          display_name: "Request Test",
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
      const requests = new RequestService(
        database.db,
        workspaces,
        new VariableService(database.db, workspaces, environments, audit),
        audit,
      );
      const workspace = await workspaces.create(userId, "Workspace");
      const original = await requests.createRequest(
        userId,
        workspace.workspaceId,
        null,
        "Example request",
        "GET",
        "https://example.test/hello",
        [],
        [],
        "",
      );

      const unchanged = await requests.update(
        userId,
        original.requestId,
        original.draftRevision,
        "  Example request  ",
        "GET",
        "https://example.test/hello",
        [],
        [],
        "",
      );

      expect(unchanged.draftRevision).toBe(0);
      expect(unchanged.name).toBe("Example request");
      expect(await audit.pendingCount()).toBe(2);

      const changed = await requests.update(
        userId,
        original.requestId,
        unchanged.draftRevision,
        "Updated request",
        "POST",
        "https://example.test/hello",
        [{ name: "page", value: "2", enabled: true }],
        [{ name: "Content-Type", value: "application/json", enabled: true }],
        '{"hello":"world"}',
      );

      expect(changed.draftRevision).toBe(1);
      expect(changed.name).toBe("Updated request");
      expect(changed.method).toBe("POST");
      expect(changed.query).toEqual([
        { name: "page", value: "2", enabled: true },
      ]);
      expect(changed.headers).toEqual([
        { name: "Content-Type", value: "application/json", enabled: true },
      ]);
      expect(changed.body).toBe('{"hello":"world"}');
      expect(await audit.pendingCount()).toBe(3);

      const temporary = await requests.prepareTemporaryExecution(
        userId,
        createEntityId(),
        workspace.workspaceId,
        null,
        {
          method: "POST",
          targetUrl: "https://example.test/temporary",
          query: [],
          headers: [],
          body: "temporary body",
        },
      );
      const execution = await database.db
        .selectFrom("executions")
        .select(["workspace_id", "request_id", "request_revision_id"])
        .where("id", "=", idToBytes(temporary.executionId))
        .executeTakeFirstOrThrow();

      expect(temporary.request.requestId).toBeUndefined();
      expect(bytesToId(execution.workspace_id)).toBe(workspace.workspaceId);
      expect(execution.request_id).toBeNull();
      expect(execution.request_revision_id).toBeNull();
      expect(await audit.pendingCount()).toBe(4);
    } finally {
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("reorders a complete sibling list with optimistic conflict detection", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-reorder-"));
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
          username: "reorder-test",
          display_name: "Reorder Test",
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
      const requests = new RequestService(
        database.db,
        workspaces,
        new VariableService(database.db, workspaces, environments, audit),
        audit,
      );
      const workspace = await workspaces.create(userId, "Workspace");
      const parent = await requests.createCollection(
        userId,
        workspace.workspaceId,
        null,
        "Parent",
      );
      const collection = await requests.createCollection(
        userId,
        workspace.workspaceId,
        parent.nodeId,
        "Collection",
      );
      const first = await requests.createRequest(
        userId,
        workspace.workspaceId,
        parent.nodeId,
        "First",
        "GET",
        "https://example.test/first",
        [],
        [],
        "",
      );
      const second = await requests.createRequest(
        userId,
        workspace.workspaceId,
        parent.nodeId,
        "Second",
        "GET",
        "https://example.test/second",
        [],
        [],
        "",
      );

      const original = await requests.listChildren(
        userId,
        workspace.workspaceId,
        parent.nodeId,
      );
      expect(original.map((node) => node.nodeId)).toEqual([
        collection.nodeId,
        first.requestId,
        second.requestId,
      ]);
      expect(original.every((node) => node.orderRevision === 0)).toBe(true);

      await expect(
        requests.reorderChildren(
          userId,
          workspace.workspaceId,
          parent.nodeId,
          0,
          [second.requestId, collection.nodeId, first.requestId],
        ),
      ).resolves.toEqual({ orderRevision: 1 });
      const reordered = await requests.listChildren(
        userId,
        workspace.workspaceId,
        parent.nodeId,
      );
      expect(
        reordered.map(({ nodeId, position, orderRevision }) => ({
          nodeId,
          position,
          orderRevision,
        })),
      ).toEqual([
        { nodeId: second.requestId, position: 0, orderRevision: 1 },
        { nodeId: collection.nodeId, position: 1, orderRevision: 1 },
        { nodeId: first.requestId, position: 2, orderRevision: 1 },
      ]);

      await expect(
        requests.reorderChildren(
          userId,
          workspace.workspaceId,
          parent.nodeId,
          0,
          [first.requestId, second.requestId, collection.nodeId],
        ),
      ).rejects.toBeInstanceOf(TreeOrderConflictError);
      const appended = await requests.createCollection(
        userId,
        workspace.workspaceId,
        parent.nodeId,
        "Appended",
      );
      expect(appended.orderRevision).toBe(1);

      await expect(
        requests.moveNode(
          userId,
          workspace.workspaceId,
          first.requestId,
          collection.nodeId,
          "inside",
          1,
        ),
      ).resolves.toEqual({
        sourceParentCollectionId: parent.nodeId,
        targetParentCollectionId: collection.nodeId,
      });
      expect(
        (
          await requests.listChildren(
            userId,
            workspace.workspaceId,
            parent.nodeId,
          )
        ).map(({ nodeId, position, orderRevision }) => ({
          nodeId,
          position,
          orderRevision,
        })),
      ).toEqual([
        { nodeId: second.requestId, position: 0, orderRevision: 2 },
        { nodeId: collection.nodeId, position: 1, orderRevision: 2 },
        { nodeId: appended.nodeId, position: 2, orderRevision: 2 },
      ]);
      expect(
        await requests.listChildren(
          userId,
          workspace.workspaceId,
          collection.nodeId,
        ),
      ).toEqual([
        expect.objectContaining({
          nodeId: first.requestId,
          position: 0,
          orderRevision: 1,
        }),
      ]);

      await expect(
        requests.moveNode(
          userId,
          workspace.workspaceId,
          collection.nodeId,
          first.requestId,
          "before",
          2,
        ),
      ).rejects.toBeInstanceOf(TreeMoveInvalidError);
      await expect(
        requests.moveNode(
          userId,
          workspace.workspaceId,
          second.requestId,
          collection.nodeId,
          "inside",
          1,
        ),
      ).rejects.toBeInstanceOf(TreeOrderConflictError);
    } finally {
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
