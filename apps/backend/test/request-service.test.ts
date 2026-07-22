import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { bytesToId, createEntityId, idToBytes } from "../src/foundation/id.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import { RequestService } from "../src/requests/request-service.js";
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
      const requests = new RequestService(database.db, workspaces, audit);
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
        workspace.workspaceId,
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
});
