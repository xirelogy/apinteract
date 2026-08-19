import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { LocalBlobStore } from "../src/blobs/local-blob-store.js";
import { EnvironmentService } from "../src/environments/environment-service.js";
import { RequestExchangeService } from "../src/exchanges/request-exchange-service.js";
import { createEntityId, idToBytes } from "../src/foundation/id.js";
import { ImportService } from "../src/imports/import-service.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import { RequestService } from "../src/requests/request-service.js";
import { VariableService } from "../src/variables/variable-service.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";

describe("RequestExchangeService", () => {
  it("sorts captures with executions and loads either representation", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-exchanges-"));
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
          username: "exchange-test",
          display_name: "Exchange Test",
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
      const imports = new ImportService(requests);
      const source = {
        name: "capture.har",
        text: JSON.stringify({
          log: {
            version: "1.2",
            entries: [
              {
                startedDateTime: "2025-02-01T00:00:00.000Z",
                request: {
                  method: "GET",
                  url: "https://example.test/items",
                  headers: [],
                },
                response: {
                  status: 200,
                  statusText: "OK",
                  headers: [{ name: "content-type", value: "text/plain" }],
                  content: { mimeType: "text/plain", text: "captured" },
                },
              },
            ],
          },
        }),
      };
      const plan = await imports.preview("har", source);
      const imported = await imports.apply(userId, "har", source, {
        workspaceId: workspace.workspaceId,
        parentCollectionId: null,
        collectionName: "Imported",
        selectedItemIds: [plan.requests[0]!.itemId],
        expectedSourceFingerprint: plan.sourceFingerprint,
      });
      const requestId = imported.requests[0]!.requestId;
      const requestRevision = await database.db
        .selectFrom("request_revisions")
        .select("id")
        .where("request_id", "=", idToBytes(requestId))
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow();
      const executionId = createEntityId();
      await database.db
        .insertInto("executions")
        .values({
          id: idToBytes(executionId),
          workspace_id: idToBytes(workspace.workspaceId),
          request_id: idToBytes(requestId),
          request_revision_id: requestRevision.id,
          created_by: idToBytes(userId),
          state: "completed",
          snapshot_json: "{}",
          response_status: 201,
          response_headers_json: JSON.stringify([
            { name: "content-type", value: "application/json" },
          ]),
          response_blob_id: null,
          body_complete: 1,
          body_bytes: 0,
          body_sha256: null,
          error_json: null,
          script_result_json: null,
          created_at: Date.parse("2026-02-01T00:00:00.000Z"),
          completed_at: Date.parse("2026-02-01T00:00:01.000Z"),
        })
        .execute();
      const exchanges = new RequestExchangeService(
        database.db,
        workspaces,
        blobs,
      );

      const summaries = await exchanges.list(userId, requestId);

      expect(summaries.map((summary) => summary.kind)).toEqual([
        "execution",
        "capture",
      ]);
      expect(summaries.map((summary) => summary.status)).toEqual([201, 200]);
      const execution = await exchanges.get(
        userId,
        requestId,
        executionId,
        "execution",
      );
      expect(execution.execution).toMatchObject({
        status: 201,
        headers: [{ name: "content-type", value: "application/json" }],
      });
      const captureSummary = summaries[1]!;
      const capture = await exchanges.get(
        userId,
        requestId,
        captureSummary.exchangeId,
        "capture",
      );
      expect(capture).toMatchObject({
        summary: { kind: "capture", source: "har" },
        execution: { status: 200, bodyPreview: "captured" },
      });
    } finally {
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
