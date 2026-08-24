import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { LocalBlobStore } from "../src/blobs/local-blob-store.js";
import { EnvironmentService } from "../src/environments/environment-service.js";
import { bytesToId, createEntityId, idToBytes } from "../src/foundation/id.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import { RequestAttachmentService } from "../src/requests/request-attachment-service.js";
import {
  RequestService,
  TreeMoveInvalidError,
  TreeOrderConflictError,
} from "../src/requests/request-service.js";
import { VariableService } from "../src/variables/variable-service.js";
import { VariableProfileConflictError } from "../src/variables/variable-profile-store.js";
import {
  AccessDeniedError,
  WorkspaceService,
} from "../src/workspaces/workspace-service.js";

describe("RequestService draft updates", () => {
  it("serializes, redacts, and restores structured form bodies", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-forms-"));
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
          username: "form-test",
          display_name: "Form Test",
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
      const blobs = new LocalBlobStore(
        join(rootPath, "blobs"),
        join(rootPath, "staging"),
      );
      await blobs.initialize();
      const attachments = new RequestAttachmentService(
        database.db,
        workspaces,
        blobs,
        audit,
      );
      const requests = new RequestService(
        database.db,
        workspaces,
        variables,
        audit,
        attachments,
      );
      const workspace = await workspaces.create(userId, "Workspace");
      const request = await requests.createRequest(
        userId,
        workspace.workspaceId,
        null,
        "Form request",
        "POST",
        "https://example.test/forms",
        [],
        [],
        "",
      );
      await variables.update(userId, "request", request.requestId, 0, [
        { name: "words", kind: "value", value: "hello world" },
        { name: "credential", kind: "secret", value: "top secret" },
      ]);

      const urlencoded = await requests.update(
        userId,
        request.requestId,
        request.draftRevision,
        request.name,
        "POST",
        request.targetUrl,
        [],
        [],
        "",
        "",
        "",
        "absolute",
        null,
        {
          kind: "urlencoded",
          contentType: null,
          fields: [
            { name: "plain", value: "<<words>>", enabled: true },
            { name: "duplicate", value: "first value", enabled: true },
            { name: "duplicate", value: "a+b&c", enabled: true },
            { name: "ignored", value: "<<missing>>", enabled: false },
            {
              name: "<<credential>>",
              value: "<<credential>>",
              enabled: true,
            },
          ],
        },
      );
      const preparedUrlencoded = await requests.prepareExecution(
        userId,
        createEntityId(),
        request.requestId,
      );

      expect(preparedUrlencoded.request.bodyPresent).toBe(true);
      expect(preparedUrlencoded.request.body).toBe(
        "plain=hello+world&duplicate=first+value&duplicate=a%2Bb%26c&top+secret=top+secret",
      );
      expect(preparedUrlencoded.request.headers).toContainEqual({
        name: "Content-Type",
        value: "application/x-www-form-urlencoded",
        enabled: true,
        mode: "override",
      });
      const executionRow = await database.db
        .selectFrom("executions")
        .select("snapshot_json")
        .where("id", "=", idToBytes(preparedUrlencoded.executionId))
        .executeTakeFirstOrThrow();
      expect(executionRow.snapshot_json).not.toContain("top secret");
      expect(JSON.parse(executionRow.snapshot_json)).toMatchObject({
        body: "plain=hello+world&duplicate=first+value&duplicate=a%2Bb%26c&%5Bsecret%5D=%5Bsecret%5D",
        requestBody: {
          kind: "urlencoded",
          fields: [
            { name: "plain", value: "hello world", enabled: true },
            { name: "duplicate", value: "first value", enabled: true },
            { name: "duplicate", value: "a+b&c", enabled: true },
            { name: "ignored", value: "<<missing>>", enabled: false },
            { name: "[secret]", value: "[secret]", enabled: true },
          ],
        },
      });

      const [urlencodedRevision] = await requests.listRevisions(
        userId,
        request.requestId,
      );
      if (urlencodedRevision === undefined) {
        throw new Error("Missing URL-encoded revision");
      }
      const boundary = "APInteractTestBoundary";
      const multipart = await requests.update(
        userId,
        request.requestId,
        urlencoded.draftRevision,
        request.name,
        "POST",
        request.targetUrl,
        [],
        [],
        "",
        "",
        "",
        "absolute",
        null,
        {
          kind: "multipart",
          contentType: null,
          boundary,
          fields: [
            { name: "alpha", value: "line 1\nline 2", enabled: true },
            { name: "disabled", value: "not sent", enabled: false },
          ],
        },
      );
      const preparedMultipart = await requests.prepareExecution(
        userId,
        createEntityId(),
        request.requestId,
      );
      expect(preparedMultipart.request.body).toBe(
        `--${boundary}\r\nContent-Disposition: form-data; name="alpha"\r\n\r\nline 1\nline 2\r\n--${boundary}--\r\n`,
      );
      expect(preparedMultipart.request.headers).toContainEqual({
        name: "Content-Type",
        value: `multipart/form-data; boundary=${boundary}`,
        enabled: true,
        mode: "override",
      });

      const attachmentBytes = Buffer.from([0, 1, 2, 255]);
      const attachment = await attachments.upload(
        userId,
        workspace.workspaceId,
        "payload.bin",
        "application/octet-stream",
        attachmentBytes,
      );
      const fileBoundary = "APInteractFileBoundary";
      const multipartFile = await requests.update(
        userId,
        request.requestId,
        multipart.draftRevision,
        request.name,
        "POST",
        request.targetUrl,
        [],
        [],
        "",
        "",
        "",
        "absolute",
        null,
        {
          kind: "multipart",
          contentType: null,
          boundary: fileBoundary,
          fields: [
            { name: "description", value: "binary", enabled: true },
            {
              kind: "file",
              name: "file-<<credential>>",
              enabled: true,
              attachment,
            },
          ],
        },
      );
      const preparedFile = await requests.prepareExecution(
        userId,
        createEntityId(),
        request.requestId,
      );
      expect(preparedFile.request.body).toBe("");
      expect(Buffer.from(preparedFile.request.bodyBytes ?? [])).toEqual(
        Buffer.concat([
          Buffer.from(
            `--${fileBoundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\nbinary\r\n--${fileBoundary}\r\nContent-Disposition: form-data; name="file-top secret"; filename="payload.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
          ),
          attachmentBytes,
          Buffer.from(`\r\n--${fileBoundary}--\r\n`),
        ]),
      );
      expect(preparedFile.request.requestBody).toMatchObject({
        kind: "multipart",
        fields: [
          { name: "description", value: "binary", enabled: true },
          { kind: "file", name: "file-top secret", attachment },
        ],
      });
      const fileExecutionRow = await database.db
        .selectFrom("executions")
        .select("snapshot_json")
        .where("id", "=", idToBytes(preparedFile.executionId))
        .executeTakeFirstOrThrow();
      expect(fileExecutionRow.snapshot_json).not.toContain("top secret");
      expect(JSON.parse(fileExecutionRow.snapshot_json)).toMatchObject({
        requestBody: {
          fields: [
            { name: "description" },
            { kind: "file", name: "[secret]", attachment },
          ],
        },
      });
      const directFile = await requests.prepareTemporaryExecution(
        userId,
        createEntityId(),
        workspace.workspaceId,
        null,
        {
          method: "POST",
          targetUrl: "https://example.test/binary-body",
          query: [],
          headers: [],
          body: "",
          requestBody: {
            kind: "file",
            contentType: null,
            attachment,
          },
        },
      );
      expect(Buffer.from(directFile.request.bodyBytes ?? [])).toEqual(
        attachmentBytes,
      );
      expect(directFile.request.requestBody).toEqual({
        kind: "file",
        contentType: null,
        attachment,
      });
      expect(directFile.request.headers).toContainEqual({
        name: "Content-Type",
        value: "application/octet-stream",
        enabled: true,
        mode: "override",
      });

      const overriddenDirectFile = await requests.prepareTemporaryExecution(
        userId,
        createEntityId(),
        workspace.workspaceId,
        null,
        {
          method: "POST",
          targetUrl: "https://example.test/custom-binary-body",
          query: [],
          headers: [],
          body: "",
          requestBody: {
            kind: "file",
            contentType: "application/vnd.example.payload",
            attachment,
          },
        },
      );
      expect(overriddenDirectFile.request.headers).toContainEqual({
        name: "Content-Type",
        value: "application/vnd.example.payload",
        enabled: true,
        mode: "override",
      });
      const otherWorkspace = await workspaces.create(userId, "Other workspace");
      await expect(
        requests.prepareTemporaryExecution(
          userId,
          createEntityId(),
          otherWorkspace.workspaceId,
          null,
          {
            method: "POST",
            targetUrl: "https://example.test/cross-workspace-file-body",
            query: [],
            headers: [],
            body: "",
            requestBody: {
              kind: "file",
              contentType: null,
              attachment,
            },
          },
        ),
      ).rejects.toThrow("attachment is unavailable");
      await expect(
        requests.prepareTemporaryExecution(
          userId,
          createEntityId(),
          otherWorkspace.workspaceId,
          null,
          {
            method: "POST",
            targetUrl: "https://example.test/cross-workspace",
            query: [],
            headers: [],
            body: "",
            requestBody: {
              kind: "multipart",
              contentType: null,
              boundary: "CrossWorkspaceBoundary",
              fields: [
                {
                  kind: "file",
                  name: "file",
                  enabled: true,
                  attachment,
                },
              ],
            },
          },
        ),
      ).rejects.toThrow("attachment is unavailable");

      const restored = await requests.restoreRevision(
        userId,
        request.requestId,
        urlencodedRevision.revisionId,
        multipartFile.draftRevision,
      );
      expect(restored.requestBody).toEqual(urlencoded.requestBody);
      expect(restored.body).toBe(
        "plain=%3C%3Cwords%3E%3E&duplicate=first+value&duplicate=a%2Bb%26c&%3C%3Ccredential%3E%3E=%3C%3Ccredential%3E%3E",
      );

      const empty = await requests.prepareTemporaryExecution(
        userId,
        createEntityId(),
        workspace.workspaceId,
        null,
        {
          method: "POST",
          targetUrl: "https://example.test/empty-form",
          query: [],
          headers: [],
          body: "",
          requestBody: {
            kind: "urlencoded",
            contentType: null,
            fields: [],
          },
        },
      );
      expect(empty.request).toMatchObject({ body: "", bodyPresent: true });
      expect(empty.request.headers).toContainEqual({
        name: "Content-Type",
        value: "application/x-www-form-urlencoded",
        enabled: true,
        mode: "override",
      });
    } finally {
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects multipart framing collisions and invalid field names", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-form-invalid-"));
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
          username: "invalid-form-test",
          display_name: "Invalid Form Test",
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
      const workspace = await workspaces.create(userId, "Workspace");
      const input = {
        method: "POST" as const,
        targetUrl: "https://example.test/forms",
        query: [],
        headers: [],
        body: "",
      };

      await expect(
        requests.prepareTemporaryExecution(
          userId,
          createEntityId(),
          workspace.workspaceId,
          null,
          {
            ...input,
            requestBody: {
              kind: "multipart",
              contentType: null,
              boundary: "CollisionBoundary",
              fields: [
                {
                  name: "field",
                  value: "contains CollisionBoundary here",
                  enabled: true,
                },
              ],
            },
          },
        ),
      ).rejects.toThrow("boundary collides");
      await expect(
        requests.prepareTemporaryExecution(
          userId,
          createEntityId(),
          workspace.workspaceId,
          null,
          {
            ...input,
            requestBody: {
              kind: "multipart",
              contentType: null,
              boundary: "SafeBoundary",
              fields: [{ name: "bad\r\nname", value: "value", enabled: true }],
            },
          },
        ),
      ).rejects.toThrow("field name is invalid");
      await expect(
        requests.prepareTemporaryExecution(
          userId,
          createEntityId(),
          workspace.workspaceId,
          null,
          {
            ...input,
            requestBody: {
              kind: "multipart",
              contentType: "multipart/form-data; boundary=ConflictingBoundary",
              boundary: "SafeBoundary",
              fields: [],
            },
          },
        ),
      ).rejects.toThrow("must not declare a boundary");
    } finally {
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

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
      expect(original.requestBody).toEqual({ kind: "none" });

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

      const variableProfile = await variables.update(
        userId,
        "request",
        original.requestId,
        0,
        [{ name: "source", kind: "value", value: "before" }],
      );
      const sourceVariable = variableProfile.variables[0];
      if (sourceVariable?.kind !== "value") {
        throw new Error("Unexpected request variable fixture");
      }

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
        "",
        "",
        "absolute",
        {
          expectedRevision: variableProfile.revision,
          variables: [{ ...sourceVariable, value: "after" }],
        },
        {
          kind: "text",
          contentType: "application/merge-patch+json",
          text: '{"hello":"<<source>>"}',
        },
      );

      expect(changed.draftRevision).toBe(1);
      expect(changed.name).toBe("Updated request");
      expect(changed.method).toBe("POST");
      expect(changed.query).toEqual([
        { name: "page", value: "2", enabled: true },
      ]);
      expect(changed.headers).toEqual([
        {
          name: "Content-Type",
          value: "application/json",
          enabled: true,
          mode: "override",
        },
      ]);
      expect(changed.body).toBe('{"hello":"<<source>>"}');
      expect(changed.requestBody).toEqual({
        kind: "text",
        contentType: "application/merge-patch+json",
        text: '{"hello":"<<source>>"}',
      });
      await expect(
        variables.get(userId, "request", original.requestId),
      ).resolves.toMatchObject({
        revision: variableProfile.revision + 1,
        variables: [
          expect.objectContaining({ name: "source", value: "after" }),
        ],
      });
      expect(await audit.pendingCount()).toBe(5);

      const savedExecution = await requests.prepareExecution(
        userId,
        createEntityId(),
        original.requestId,
      );
      expect(savedExecution.request.bodyPresent).toBe(true);
      expect(savedExecution.request.body).toBe('{"hello":"after"}');
      expect(savedExecution.request.headers).toEqual([
        {
          name: "Content-Type",
          value: "application/merge-patch+json",
          enabled: true,
          mode: "override",
        },
      ]);

      await expect(
        requests.update(
          userId,
          original.requestId,
          changed.draftRevision,
          "Should roll back",
          "POST",
          "https://example.test/hello",
          [],
          [],
          "",
          "",
          "",
          "absolute",
          {
            expectedRevision: variableProfile.revision,
            variables: [{ ...sourceVariable, value: "stale" }],
          },
        ),
      ).rejects.toBeInstanceOf(VariableProfileConflictError);
      await expect(
        requests.get(userId, original.requestId),
      ).resolves.toMatchObject({
        name: "Updated request",
        draftRevision: changed.draftRevision,
      });

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
          requestBody: { kind: "text", contentType: null, text: "" },
          body: "",
        },
      );
      const noBody = await requests.prepareTemporaryExecution(
        userId,
        createEntityId(),
        workspace.workspaceId,
        null,
        {
          method: "POST",
          targetUrl: "https://example.test/no-body",
          query: [],
          headers: [],
          body: "",
        },
      );
      const execution = await database.db
        .selectFrom("executions")
        .select(["workspace_id", "request_id", "request_revision_id"])
        .where("id", "=", idToBytes(temporary.executionId))
        .executeTakeFirstOrThrow();

      expect(temporary.request.requestId).toBeUndefined();
      expect(temporary.request.bodyPresent).toBe(true);
      expect(noBody.request.bodyPresent).toBe(false);
      expect(bytesToId(execution.workspace_id)).toBe(workspace.workspaceId);
      expect(execution.request_id).toBeNull();
      expect(execution.request_revision_id).toBeNull();
      expect(await audit.pendingCount()).toBe(8);
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

  it("duplicates saved content and variables beside the source without history", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-duplicate-"));
    const database = await SqliteDatabase.open(
      join(rootPath, "database.sqlite"),
    );

    try {
      const userId = createEntityId();
      const viewerId = createEntityId();
      await database.db
        .insertInto("users")
        .values([
          {
            id: idToBytes(userId),
            status: "active",
            username: "duplicate-test",
            display_name: "Duplicate Test",
            is_instance_admin: 0,
            created_at: Date.now(),
            deleted_at: null,
          },
          {
            id: idToBytes(viewerId),
            status: "active",
            username: "duplicate-viewer",
            display_name: "Duplicate Viewer",
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
      await database.db
        .insertInto("workspace_memberships")
        .values({
          workspace_id: idToBytes(workspace.workspaceId),
          user_id: idToBytes(viewerId),
          role: "viewer",
          created_at: Date.now(),
        })
        .execute();
      const before = await requests.createRequest(
        userId,
        workspace.workspaceId,
        null,
        "Before",
        "GET",
        "https://example.test/before",
        [],
        [],
        "",
      );
      const source = await requests.createRequest(
        userId,
        workspace.workspaceId,
        null,
        "Source",
        "POST",
        "https://example.test/items",
        [
          {
            name: "page",
            value: "2",
            enabled: true,
            description: "Pagination",
          },
        ],
        [
          {
            name: "Accept",
            value: "application/json",
            enabled: true,
            description: "Response format",
          },
        ],
        '{"source":true}',
        "asdk.request.header.set('X-Before', '1');",
        "asdk.test('status', () => asdk.expect(true).toBeTruthy());",
        "absolute",
        undefined,
        { description: "Source request", notes: "# Source notes" },
      );
      const after = await requests.createRequest(
        userId,
        workspace.workspaceId,
        null,
        "After",
        "GET",
        "https://example.test/after",
        [],
        [],
        "",
      );
      const profile = await variables.update(
        userId,
        "request",
        source.requestId,
        0,
        [
          {
            name: "plain",
            kind: "value",
            value: "visible",
            description: "Visible value",
          },
          { name: "stored", kind: "secret", value: "top-secret" },
          { name: "empty", kind: "secret", value: "clear-me" },
        ],
      );
      const [plain, stored, empty] = profile.variables;
      if (
        plain?.kind !== "value" ||
        stored?.kind !== "secret" ||
        empty?.kind !== "secret"
      ) {
        throw new Error("Unexpected variable profile fixture");
      }
      await variables.update(
        userId,
        "request",
        source.requestId,
        profile.revision,
        [
          { ...plain, value: plain.value },
          { variableId: stored.variableId, name: stored.name, kind: "secret" },
          {
            variableId: empty.variableId,
            name: empty.name,
            kind: "secret",
            clearValue: true,
          },
        ],
      );
      await requests.prepareExecution(
        userId,
        createEntityId(),
        source.requestId,
      );
      const sourceRevisions = await requests.listRevisions(
        userId,
        source.requestId,
      );
      expect(sourceRevisions).toHaveLength(1);
      expect(
        await requests.getRevision(
          userId,
          source.requestId,
          sourceRevisions[0]!.revisionId,
        ),
      ).toMatchObject({
        request: {
          description: "Source request",
          notes: "# Source notes",
          query: [expect.objectContaining({ description: "Pagination" })],
          headers: [
            expect.objectContaining({ description: "Response format" }),
          ],
        },
      });

      await expect(
        requests.duplicate(viewerId, source.requestId, "Forbidden copy"),
      ).rejects.toBeInstanceOf(AccessDeniedError);

      const duplicate = await requests.duplicate(
        userId,
        source.requestId,
        "Source copy",
      );

      expect(duplicate).toMatchObject({
        name: "Source copy",
        description: "Source request",
        notes: "# Source notes",
        method: source.method,
        targetUrl: source.targetUrl,
        query: source.query,
        headers: source.headers,
        body: source.body,
        preRequestScript: source.preRequestScript,
        postResponseScript: source.postResponseScript,
        draftRevision: 0,
      });
      expect(
        (await requests.listChildren(userId, workspace.workspaceId, null)).map(
          (node) => node.nodeId,
        ),
      ).toEqual([
        before.requestId,
        source.requestId,
        duplicate.requestId,
        after.requestId,
      ]);
      const duplicateProfile = await variables.get(
        userId,
        "request",
        duplicate.requestId,
      );
      expect(duplicateProfile.revision).toBe(1);
      expect(duplicateProfile.variables).toEqual([
        expect.objectContaining({
          name: "plain",
          kind: "value",
          value: "visible",
          description: "Visible value",
        }),
        expect.objectContaining({
          name: "stored",
          kind: "secret",
          hasValue: true,
          secretVersion: 1,
        }),
        expect.objectContaining({
          name: "empty",
          kind: "secret",
          hasValue: false,
          secretVersion: 1,
        }),
      ]);
      expect(
        duplicateProfile.variables.map((variable) => variable.variableId),
      ).not.toEqual(profile.variables.map((variable) => variable.variableId));
      expect(
        await database.db
          .selectFrom("variable_profiles as profile")
          .innerJoin(
            "variables as variable",
            "variable.profile_id",
            "profile.id",
          )
          .innerJoin(
            "variable_secrets as secret",
            "secret.variable_id",
            "variable.id",
          )
          .select(["variable.name", "secret.payload"])
          .where("profile.scope_kind", "=", "request")
          .where("profile.scope_id", "=", idToBytes(duplicate.requestId))
          .orderBy("variable.position")
          .execute(),
      ).toEqual([
        { name: "stored", payload: "top-secret" },
        { name: "empty", payload: null },
      ]);
      expect(
        await database.db
          .selectFrom("request_revisions")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("request_id", "=", idToBytes(duplicate.requestId))
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: 0 });
      expect(
        await database.db
          .selectFrom("executions")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("request_id", "=", idToBytes(duplicate.requestId))
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: 0 });
    } finally {
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("saves, names, restores, and prepares immutable request revisions", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-versions-"));
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
          username: "version-test",
          display_name: "Version Test",
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
      const workspace = await workspaces.create(userId, "Workspace");
      const request = await requests.createRequest(
        userId,
        workspace.workspaceId,
        null,
        "Versions",
        "GET",
        "https://example.test/first",
        [],
        [{ name: "X-Local", value: "first", enabled: true }],
        "first",
      );
      const saved = await requests.update(
        userId,
        request.requestId,
        request.draftRevision,
        request.name,
        "POST",
        "https://example.test/second",
        [
          {
            name: "page",
            value: "2",
            enabled: true,
            description: "Page number",
          },
        ],
        [
          {
            name: "X-Local",
            value: "second",
            enabled: true,
            description: "Local header",
          },
        ],
        "",
        "",
        "",
        "absolute",
        null,
        { kind: "text", contentType: "application/json", text: "" },
        "Request summary",
        "# Request notes",
      );
      const [firstRevision] = await requests.listRevisions(
        userId,
        request.requestId,
      );
      expect(firstRevision).toMatchObject({
        creationReason: "manual_save",
        name: null,
        createdByUsername: "version-test",
      });
      if (firstRevision === undefined) throw new Error("Missing revision");
      await requests.nameRevision(
        userId,
        request.requestId,
        firstRevision.revisionId,
        "Release candidate",
      );
      expect(
        await requests.getRevision(
          userId,
          request.requestId,
          firstRevision.revisionId,
        ),
      ).toMatchObject({
        name: "Release candidate",
        request: {
          description: "Request summary",
          notes: "# Request notes",
          method: "POST",
          targetUrl: "https://example.test/second",
          body: "",
          requestBody: {
            kind: "text",
            contentType: "application/json",
            text: "",
          },
          query: [expect.objectContaining({ description: "Page number" })],
          headers: [expect.objectContaining({ description: "Local header" })],
        },
      });
      const changed = await requests.update(
        userId,
        request.requestId,
        saved.draftRevision,
        request.name,
        "DELETE",
        "https://example.test/third",
        [],
        [],
        "third",
      );
      const restored = await requests.restoreRevision(
        userId,
        request.requestId,
        firstRevision.revisionId,
        changed.draftRevision,
      );
      expect(restored).toMatchObject({
        description: "Request summary",
        notes: "# Request notes",
        method: "POST",
        targetUrl: "https://example.test/second",
        body: "",
        requestBody: {
          kind: "text",
          contentType: "application/json",
          text: "",
        },
      });
      const prepared = await requests.prepareRevisionExecution(
        userId,
        createEntityId(),
        request.requestId,
        firstRevision.revisionId,
      );
      expect(prepared.revisionId).toBe(firstRevision.revisionId);
      expect(prepared.request).toMatchObject({
        method: "POST",
        targetUrl: "https://example.test/second",
        body: "",
        bodyPresent: true,
        requestBody: {
          kind: "text",
          contentType: "application/json",
          text: "",
        },
      });
      expect(JSON.stringify(prepared.request)).not.toContain("Page number");
      expect(JSON.stringify(prepared.request)).not.toContain("Local header");
      expect(JSON.stringify(prepared.request)).not.toContain("Request summary");
      expect(JSON.stringify(prepared.request)).not.toContain("Request notes");
      expect(JSON.stringify(prepared.templateRequest)).not.toContain(
        "Request summary",
      );
      const executionSnapshot = await database.db
        .selectFrom("executions")
        .select("snapshot_json")
        .where("id", "=", idToBytes(prepared.executionId))
        .executeTakeFirstOrThrow();
      expect(executionSnapshot.snapshot_json).not.toContain("Request summary");
      expect(executionSnapshot.snapshot_json).not.toContain("Request notes");
      expect(prepared.request.headers).toContainEqual({
        name: "Content-Type",
        value: "application/json",
        enabled: true,
        mode: "override",
      });
      expect(
        await requests.listRevisions(userId, request.requestId),
      ).toHaveLength(4);
    } finally {
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("composes nested collection paths and snapshots them for revisions", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-paths-"));
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
          username: "path-test",
          display_name: "Path Test",
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
      const workspaceSummary = await workspaces.create(userId, "Workspace");
      const workspace = await workspaces.get(
        userId,
        workspaceSummary.workspaceId,
      );
      const root = await requests.createCollection(
        userId,
        workspace.workspaceId,
        null,
        "API",
      );
      let rootView = await requests.getCollection(userId, root.nodeId);
      rootView = await requests.updateCollection(
        userId,
        root.nodeId,
        rootView.revision,
        rootView.name,
        [],
        "",
      );
      const child = await requests.createCollection(
        userId,
        workspace.workspaceId,
        root.nodeId,
        "Users",
      );
      let childView = await requests.getCollection(userId, child.nodeId);
      childView = await requests.updateCollection(
        userId,
        child.nodeId,
        childView.revision,
        childView.name,
        [],
        "https://api.example.test/root/v1/users/",
      );
      expect(childView.effectivePath).toBe(
        "https://api.example.test/root/v1/users/",
      );

      const composed = await requests.createRequest(
        userId,
        workspace.workspaceId,
        child.nodeId,
        "User",
        "GET",
        "/42",
        [],
        [],
        "",
        "",
        "",
        "composed",
      );
      expect(composed).toMatchObject({
        targetMode: "composed",
        inheritedTarget: "https://api.example.test/root/v1/users/",
      });
      const original = await requests.prepareExecution(
        userId,
        createEntityId(),
        composed.requestId,
      );
      expect(original.request.targetUrl).toBe(
        "https://api.example.test/root/v1/users/42",
      );
      if (original.revisionId === undefined) {
        throw new Error("Missing composed request revision");
      }
      const composedDuplicate = await requests.duplicate(
        userId,
        composed.requestId,
        "User copy",
      );
      expect(composedDuplicate.targetMode).toBe("composed");
      expect(composedDuplicate.targetUrl).toBe("/42");

      await requests.updateCollection(
        userId,
        root.nodeId,
        rootView.revision,
        rootView.name,
        [],
        "https://api.example.test/root/v2",
      );
      const updatedChild = await requests.updateCollection(
        userId,
        child.nodeId,
        childView.revision,
        childView.name,
        [],
        "/users",
      );
      expect(updatedChild.inheritedTarget).toBe(
        "https://api.example.test/root/v2",
      );
      const current = await requests.prepareExecution(
        userId,
        createEntityId(),
        composed.requestId,
      );
      expect(current.request.targetUrl).toBe(
        "https://api.example.test/root/v2/users/42",
      );
      const historical = await requests.prepareRevisionExecution(
        userId,
        createEntityId(),
        composed.requestId,
        original.revisionId,
      );
      expect(historical.request.targetUrl).toBe(
        "https://api.example.test/root/v1/users/42",
      );

      const absolute = await requests.createRequest(
        userId,
        workspace.workspaceId,
        child.nodeId,
        "Status",
        "GET",
        "https://status.example.test/health",
        [],
        [],
        "",
      );
      const absoluteExecution = await requests.prepareExecution(
        userId,
        createEntityId(),
        absolute.requestId,
      );
      expect(absoluteExecution.request.targetUrl).toBe(
        "https://status.example.test/health",
      );

      const serviceRoot = await requests.createCollection(
        userId,
        workspace.workspaceId,
        null,
        "Service root",
      );
      const serviceRootView = await requests.getCollection(
        userId,
        serviceRoot.nodeId,
      );
      await requests.updateCollection(
        userId,
        serviceRoot.nodeId,
        serviceRootView.revision,
        serviceRootView.name,
        [],
        "https://root.example.test/api",
      );
      const rootComposed = await requests.createRequest(
        userId,
        workspace.workspaceId,
        serviceRoot.nodeId,
        "Root-composed",
        "GET",
        "/health",
        [],
        [],
        "",
        "",
        "",
        "composed",
      );
      const rootExecution = await requests.prepareExecution(
        userId,
        createEntityId(),
        rootComposed.requestId,
      );
      expect(rootExecution.request.targetUrl).toBe(
        "https://root.example.test/api/health",
      );

      const variableRoot = await requests.createCollection(
        userId,
        workspace.workspaceId,
        null,
        "Variable service",
      );
      const variableRootView = await requests.getCollection(
        userId,
        variableRoot.nodeId,
      );
      await requests.updateCollection(
        userId,
        variableRoot.nodeId,
        variableRootView.revision,
        variableRootView.name,
        [],
        "<<service_url>>/<<api_version>>",
      );
      const variableLeaf = await requests.createCollection(
        userId,
        workspace.workspaceId,
        variableRoot.nodeId,
        "Variable resource",
      );
      await requests.updateCollection(
        userId,
        variableLeaf.nodeId,
        0,
        "Variable resource",
        [],
        "/<<resource>>",
      );
      await variables.update(userId, "collection", variableRoot.nodeId, 0, [
        {
          name: "service_url",
          kind: "value",
          value: "https://variables.example.test/root",
        },
        { name: "api_version", kind: "value", value: "v3" },
      ]);
      await variables.update(userId, "collection", variableLeaf.nodeId, 0, [
        { name: "resource", kind: "value", value: "users" },
        { name: "identifier", kind: "value", value: "42" },
      ]);
      const variableRequest = await requests.createRequest(
        userId,
        workspace.workspaceId,
        variableLeaf.nodeId,
        "Variable target",
        "GET",
        "/<<identifier>>",
        [],
        [],
        "",
        "",
        "",
        "composed",
        undefined,
        {
          variables: [{ name: "identifier", kind: "value", value: "84" }],
        },
      );
      const variableExecution = await requests.prepareExecution(
        userId,
        createEntityId(),
        variableRequest.requestId,
      );
      expect(variableExecution.request.targetUrl).toBe(
        "https://variables.example.test/root/v3/users/84",
      );
      await expect(
        variables.get(userId, "request", variableRequest.requestId),
      ).resolves.toMatchObject({
        revision: 1,
        variables: [{ name: "identifier", kind: "value", value: "84" }],
      });

      const temporaryExecution = await requests.prepareTemporaryExecution(
        userId,
        createEntityId(),
        workspace.workspaceId,
        variableLeaf.nodeId,
        {
          method: "GET",
          targetMode: "composed",
          targetUrl: "/<<identifier>>",
          query: [],
          headers: [],
          body: "",
        },
        {
          scopeId: createEntityId(),
          scopeName: "Unsaved request",
          variables: [{ name: "identifier", kind: "value", value: "126" }],
        },
      );
      expect(temporaryExecution.request.targetUrl).toBe(
        "https://variables.example.test/root/v3/users/126",
      );
    } finally {
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
