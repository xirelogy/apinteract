import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { EnvironmentService } from "../src/environments/environment-service.js";
import { bytesToId, createEntityId, idToBytes } from "../src/foundation/id.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import {
  CollectionProfileConflictError,
  DraftConflictError,
  RequestService,
} from "../src/requests/request-service.js";
import { VariableService } from "../src/variables/variable-service.js";
import {
  AccessDeniedError,
  ResourceNotFoundError,
  WorkspaceConflictError,
  WorkspaceService,
} from "../src/workspaces/workspace-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("resource deletion", () => {
  it("tombstones owner-deleted workspaces while preserving their history", async () => {
    const fixture = await createFixture();
    try {
      const request = await createRequest(
        fixture,
        fixture.workspace.workspaceId,
        null,
        "Historical request",
      );
      const prepared = await fixture.requests.prepareExecution(
        fixture.ownerId,
        createEntityId(),
        request.requestId,
      );
      const updated = await fixture.workspaces.update(
        fixture.ownerId,
        fixture.workspace.workspaceId,
        0,
        "Renamed workspace",
        [],
      );

      await expect(
        fixture.workspaces.delete(
          fixture.ownerId,
          fixture.workspace.workspaceId,
          0,
        ),
      ).rejects.toBeInstanceOf(WorkspaceConflictError);
      await expect(
        fixture.workspaces.delete(
          fixture.editorId,
          fixture.workspace.workspaceId,
          updated.revision,
        ),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        fixture.workspaces.delete(
          fixture.ownerId,
          fixture.workspace.workspaceId,
          updated.revision,
        ),
      ).resolves.toEqual({ deleted: true });

      await expect(
        fixture.workspaces.get(fixture.ownerId, fixture.workspace.workspaceId),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(fixture.workspaces.list(fixture.ownerId)).resolves.toEqual(
        [],
      );
      await expect(
        fixture.requests.get(fixture.ownerId, request.requestId),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
      const persistedWorkspace = await fixture.database.db
        .selectFrom("workspaces")
        .select(["deleted_by", "deleted_at"])
        .where("id", "=", idToBytes(fixture.workspace.workspaceId))
        .executeTakeFirstOrThrow();
      const execution = await fixture.database.db
        .selectFrom("executions")
        .select(["request_id", "request_revision_id", "snapshot_json"])
        .where("id", "=", idToBytes(prepared.executionId))
        .executeTakeFirstOrThrow();
      expect(bytesToId(persistedWorkspace.deleted_by!)).toBe(fixture.ownerId);
      expect(persistedWorkspace.deleted_at).not.toBeNull();
      expect(bytesToId(execution.request_id!)).toBe(request.requestId);
      expect(bytesToId(execution.request_revision_id!)).toBe(
        prepared.revisionId,
      );
      expect(execution.snapshot_json).toContain("Historical%20request");
    } finally {
      await fixture.database.close();
    }
  });

  it("deletes request state, compacts siblings, and detaches executions", async () => {
    const fixture = await createFixture();
    try {
      const parent = await fixture.requests.createCollection(
        fixture.ownerId,
        fixture.workspace.workspaceId,
        null,
        "Parent",
      );
      const first = await createRequest(
        fixture,
        fixture.workspace.workspaceId,
        parent.nodeId,
        "First",
      );
      const target = await createRequest(
        fixture,
        fixture.workspace.workspaceId,
        parent.nodeId,
        "Target",
      );
      const last = await createRequest(
        fixture,
        fixture.workspace.workspaceId,
        parent.nodeId,
        "Last",
      );
      const updated = await fixture.requests.update(
        fixture.ownerId,
        target.requestId,
        target.draftRevision,
        "Updated target",
        target.method,
        target.targetUrl,
        target.query,
        target.headers,
        target.body,
      );
      await fixture.variables.update(
        fixture.ownerId,
        "request",
        target.requestId,
        0,
        [{ name: "token", kind: "secret", value: "request-secret" }],
      );
      const prepared = await fixture.requests.prepareExecution(
        fixture.ownerId,
        createEntityId(),
        target.requestId,
      );

      await expect(
        fixture.requests.delete(
          fixture.viewerId,
          target.requestId,
          updated.draftRevision,
        ),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        fixture.requests.delete(fixture.ownerId, target.requestId, 0),
      ).rejects.toBeInstanceOf(DraftConflictError);
      await expect(
        fixture.requests.delete(
          fixture.editorId,
          target.requestId,
          updated.draftRevision,
        ),
      ).resolves.toEqual({ deleted: true });

      await expect(
        fixture.requests.get(fixture.ownerId, target.requestId),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(
        fixture.requests.listChildren(
          fixture.ownerId,
          fixture.workspace.workspaceId,
          parent.nodeId,
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          nodeId: first.requestId,
          position: 0,
          orderRevision: 1,
        }),
        expect.objectContaining({
          nodeId: last.requestId,
          position: 1,
          orderRevision: 1,
        }),
      ]);
      const execution = await fixture.database.db
        .selectFrom("executions")
        .select(["request_id", "request_revision_id", "snapshot_json"])
        .where("id", "=", idToBytes(prepared.executionId))
        .executeTakeFirstOrThrow();
      expect(execution.request_id).toBeNull();
      expect(execution.request_revision_id).toBeNull();
      expect(execution.snapshot_json).toContain("example.test/Target");
      await expect(
        fixture.database.db
          .selectFrom("request_revisions")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("request_id", "=", idToBytes(target.requestId))
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ count: 0 });
      await expect(
        fixture.database.db
          .selectFrom("variable_profiles")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("scope_kind", "=", "request")
          .where("scope_id", "=", idToBytes(target.requestId))
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ count: 0 });
    } finally {
      await fixture.database.close();
    }
  });

  it("recursively deletes collection descendants and retains their executions", async () => {
    const fixture = await createFixture();
    try {
      const parent = await fixture.requests.createCollection(
        fixture.ownerId,
        fixture.workspace.workspaceId,
        null,
        "Parent",
      );
      const before = await createRequest(
        fixture,
        fixture.workspace.workspaceId,
        parent.nodeId,
        "Before",
      );
      const target = await fixture.requests.createCollection(
        fixture.ownerId,
        fixture.workspace.workspaceId,
        parent.nodeId,
        "Target",
      );
      const after = await createRequest(
        fixture,
        fixture.workspace.workspaceId,
        parent.nodeId,
        "After",
      );
      const nested = await fixture.requests.createCollection(
        fixture.ownerId,
        fixture.workspace.workspaceId,
        target.nodeId,
        "Nested",
      );
      const nestedRequest = await createRequest(
        fixture,
        fixture.workspace.workspaceId,
        nested.nodeId,
        "Nested request",
      );
      const updated = await fixture.requests.updateCollection(
        fixture.ownerId,
        target.nodeId,
        0,
        "Renamed target",
        [],
      );
      await fixture.variables.update(
        fixture.ownerId,
        "collection",
        target.nodeId,
        0,
        [{ name: "token", kind: "secret", value: "collection-secret" }],
      );
      const prepared = await fixture.requests.prepareExecution(
        fixture.ownerId,
        createEntityId(),
        nestedRequest.requestId,
      );

      await expect(
        fixture.requests.deleteCollection(fixture.ownerId, target.nodeId, 0),
      ).rejects.toBeInstanceOf(CollectionProfileConflictError);
      await expect(
        fixture.requests.deleteCollection(
          fixture.viewerId,
          target.nodeId,
          updated.revision,
        ),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        fixture.requests.deleteCollection(
          fixture.editorId,
          target.nodeId,
          updated.revision,
        ),
      ).resolves.toEqual({ deleted: true });

      await expect(
        fixture.requests.listChildren(
          fixture.ownerId,
          fixture.workspace.workspaceId,
          parent.nodeId,
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          nodeId: before.requestId,
          position: 0,
          orderRevision: 1,
        }),
        expect.objectContaining({
          nodeId: after.requestId,
          position: 1,
          orderRevision: 1,
        }),
      ]);
      await expect(
        fixture.requests.getCollection(fixture.ownerId, target.nodeId),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(
        fixture.requests.getCollection(fixture.ownerId, nested.nodeId),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(
        fixture.requests.get(fixture.ownerId, nestedRequest.requestId),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
      const execution = await fixture.database.db
        .selectFrom("executions")
        .select(["request_id", "request_revision_id", "snapshot_json"])
        .where("id", "=", idToBytes(prepared.executionId))
        .executeTakeFirstOrThrow();
      expect(execution.request_id).toBeNull();
      expect(execution.request_revision_id).toBeNull();
      expect(execution.snapshot_json).toContain("Nested%20request");
      await expect(
        fixture.database.db
          .selectFrom("variable_profiles")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("scope_id", "=", idToBytes(target.nodeId))
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ count: 0 });
    } finally {
      await fixture.database.close();
    }
  });
});

/** Creates an isolated multi-role workspace and its collaborating services. */
async function createFixture() {
  const rootPath = await mkdtemp(join(tmpdir(), "apinteract-delete-"));
  roots.push(rootPath);
  const database = await SqliteDatabase.open(join(rootPath, "database.sqlite"));
  const ownerId = createEntityId();
  const editorId = createEntityId();
  const viewerId = createEntityId();
  const now = Date.now();
  await database.db
    .insertInto("users")
    .values([
      {
        id: idToBytes(ownerId),
        status: "active",
        username: "deletion-owner",
        display_name: "Deletion Owner",
        is_instance_admin: 0,
        created_at: now,
        deleted_at: null,
      },
      {
        id: idToBytes(editorId),
        status: "active",
        username: "deletion-editor",
        display_name: "Deletion Editor",
        is_instance_admin: 0,
        created_at: now,
        deleted_at: null,
      },
      {
        id: idToBytes(viewerId),
        status: "active",
        username: "deletion-viewer",
        display_name: "Deletion Viewer",
        is_instance_admin: 0,
        created_at: now,
        deleted_at: null,
      },
    ])
    .execute();
  const audit = new AuditService(database.db, join(rootPath, "audit"));
  const workspaces = new WorkspaceService(database.db, audit);
  const environments = new EnvironmentService(database.db, workspaces, audit);
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
  const workspace = await workspaces.create(ownerId, "Deletion workspace");
  await database.db
    .insertInto("workspace_memberships")
    .values([
      {
        workspace_id: idToBytes(workspace.workspaceId),
        user_id: idToBytes(editorId),
        role: "editor",
        created_at: now,
      },
      {
        workspace_id: idToBytes(workspace.workspaceId),
        user_id: idToBytes(viewerId),
        role: "viewer",
        created_at: now,
      },
    ])
    .execute();
  return {
    database,
    ownerId,
    editorId,
    viewerId,
    workspaces,
    requests,
    variables,
    workspace,
  };
}

/** Creates one minimal saved request for deletion scenarios. */
async function createRequest(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  workspaceId: string,
  parentCollectionId: string | null,
  name: string,
) {
  return fixture.requests.createRequest(
    fixture.ownerId,
    workspaceId,
    parentCollectionId,
    name,
    "GET",
    `https://example.test/${encodeURIComponent(name)}`,
    [],
    [],
    "",
  );
}
