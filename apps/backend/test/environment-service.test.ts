import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import {
  EnvironmentConflictError,
  EnvironmentService,
} from "../src/environments/environment-service.js";
import {
  VariableResolutionError,
  VariableResolver,
} from "../src/environments/variable-resolver.js";
import {
  createEntityId,
  idToBytes,
  type EntityId,
} from "../src/foundation/id.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import { RequestService } from "../src/requests/request-service.js";
import { VariableService } from "../src/variables/variable-service.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";

describe("environment service", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("isolates selections per session and preserves redacted secret versions", async () => {
    const fixture = await createFixture(roots);
    try {
      const first = await fixture.environments.create(
        fixture.userId,
        fixture.workspaceId,
        "Development",
        [
          { name: "base", kind: "value", value: "https://dev.example" },
          { name: "token", kind: "secret", value: "initial-secret" },
        ],
      );
      await expect(
        fixture.environments.create(
          fixture.userId,
          fixture.workspaceId,
          "development",
          [],
        ),
      ).rejects.toThrow();
      const second = await fixture.environments.create(
        fixture.userId,
        fixture.workspaceId,
        "Production",
        [],
      );

      await fixture.environments.select(
        fixture.userId,
        fixture.firstSessionId,
        fixture.workspaceId,
        first.environmentId,
      );
      await fixture.environments.select(
        fixture.userId,
        fixture.secondSessionId,
        fixture.workspaceId,
        second.environmentId,
      );
      await expect(
        fixture.environments.list(
          fixture.userId,
          fixture.firstSessionId,
          fixture.workspaceId,
        ),
      ).resolves.toMatchObject({ selectedEnvironmentId: first.environmentId });
      await expect(
        fixture.environments.list(
          fixture.userId,
          fixture.secondSessionId,
          fixture.workspaceId,
        ),
      ).resolves.toMatchObject({ selectedEnvironmentId: second.environmentId });

      const secret = first.variables[1];
      const ordinary = first.variables[0];
      if (ordinary?.kind !== "value" || secret?.kind !== "secret") {
        throw new Error("Fixture variables did not retain their kinds");
      }
      expect(secret).toMatchObject({
        kind: "secret",
        hasValue: true,
        secretVersion: 1,
      });
      expect(JSON.stringify(first)).not.toContain("initial-secret");
      const preserved = await fixture.environments.update(
        fixture.userId,
        first.environmentId,
        first.revision,
        "DEVELOPMENT",
        [
          {
            variableId: ordinary.variableId,
            name: ordinary.name,
            kind: "value",
            value: ordinary.value,
          },
          {
            variableId: secret.variableId,
            name: secret.name,
            kind: "secret",
          },
        ],
      );
      expect(preserved.name).toBe("DEVELOPMENT");
      expect(preserved.variables[1]).toMatchObject({ secretVersion: 1 });
      await expect(
        fixture.environments.update(
          fixture.userId,
          first.environmentId,
          preserved.revision,
          preserved.name,
          [
            {
              variableId: secret.variableId,
              name: secret.name,
              kind: "value",
              value: "not-a-secret",
            },
          ],
        ),
      ).rejects.toBeInstanceOf(EnvironmentConflictError);
      await expect(
        fixture.environments.update(
          fixture.userId,
          first.environmentId,
          first.revision,
          "stale",
          [],
        ),
      ).rejects.toBeInstanceOf(EnvironmentConflictError);

      await fixture.environments.delete(
        fixture.userId,
        first.environmentId,
        preserved.revision,
      );
      await expect(
        fixture.environments.list(
          fixture.userId,
          fixture.firstSessionId,
          fixture.workspaceId,
        ),
      ).resolves.toMatchObject({ selectedEnvironmentId: null });
    } finally {
      await fixture.database.close();
    }
  });

  it("interpolates selected variables without persisting secret plaintext", async () => {
    const fixture = await createFixture(roots);
    try {
      const environment = await fixture.environments.create(
        fixture.userId,
        fixture.workspaceId,
        "Development",
        [
          { name: "base", kind: "value", value: "https://dev.example" },
          { name: "token", kind: "secret", value: "top-secret-token" },
          { name: "auth", kind: "alias", target: "token" },
          { name: "broken", kind: "alias", target: "missing" },
        ],
      );
      await fixture.environments.select(
        fixture.userId,
        fixture.firstSessionId,
        fixture.workspaceId,
        environment.environmentId,
      );
      const preview = await fixture.environments.previewVariables(
        fixture.userId,
        fixture.firstSessionId,
        fixture.workspaceId,
        ["base", "token", "auth", "broken", "missing"],
      );
      expect(preview.previews).toMatchObject([
        {
          name: "base",
          status: "resolved",
          declaredKind: "value",
          effectiveKind: "value",
          value: "https://dev.example",
        },
        {
          name: "token",
          status: "resolved",
          declaredKind: "secret",
          effectiveKind: "secret",
          value: null,
          secretVersion: 1,
        },
        {
          name: "auth",
          status: "resolved",
          declaredKind: "alias",
          effectiveKind: "secret",
          aliasTarget: "token",
          value: null,
          secretVersion: 1,
        },
        { name: "broken", status: "error", declaredKind: "alias" },
        { name: "missing", status: "missing", source: null },
      ]);
      expect(JSON.stringify(preview)).not.toContain("top-secret-token");
      await expect(
        fixture.environments.previewVariables(
          fixture.userId,
          fixture.secondSessionId,
          fixture.workspaceId,
          ["base"],
        ),
      ).resolves.toMatchObject({
        previews: [{ name: "base", status: "missing", source: null }],
      });
      const prepared = await fixture.requests.prepareTemporaryExecution(
        fixture.userId,
        fixture.firstSessionId,
        fixture.workspaceId,
        null,
        {
          method: "POST",
          targetUrl: "<<base>>/resource",
          query: [{ name: "page", value: "2", enabled: true }],
          headers: [
            { name: "Authorization", value: "Bearer <<auth>>", enabled: true },
            { name: "X-Ignored", value: "<<missing>>", enabled: false },
          ],
          body: "token=<<token>>",
        },
      );
      expect(prepared.request).toMatchObject({
        targetUrl: "https://dev.example/resource",
        headers: [
          {
            name: "Authorization",
            value: "Bearer top-secret-token",
            enabled: true,
          },
        ],
        body: "token=top-secret-token",
      });
      const execution = await fixture.database.db
        .selectFrom("executions")
        .select("snapshot_json")
        .where("id", "=", idToBytes(prepared.executionId))
        .executeTakeFirstOrThrow();
      expect(execution.snapshot_json).not.toContain("top-secret-token");
      expect(execution.snapshot_json).toContain('"secretReferences"');

      const profile = await fixture.environments.selectedProfile(
        fixture.database.db,
        fixture.firstSessionId,
        fixture.workspaceId,
      );
      const resolver = new VariableResolver(profile);
      expect(() => resolver.interpolate("<<broken>>")).toThrow(
        VariableResolutionError,
      );
      expect(() => resolver.interpolate("unused text")).not.toThrow();

      await fixture.audit.publishPending();
      const auditText = await readFile(
        join(
          fixture.rootPath,
          "audit",
          `${new Date().toISOString().slice(0, 10)}.jsonl`,
        ),
        "utf8",
      );
      expect(auditText).not.toContain("top-secret-token");
    } finally {
      await fixture.database.close();
    }
  });
});

/** Creates users, sessions, workspace, and environment-aware services. */
async function createFixture(roots: string[]) {
  const rootPath = await mkdtemp(join(tmpdir(), "apinteract-environment-"));
  roots.push(rootPath);
  const database = await SqliteDatabase.open(join(rootPath, "app.sqlite3"));
  const userId = createEntityId();
  const firstSessionId = createEntityId();
  const secondSessionId = createEntityId();
  const now = Date.now();
  await database.db
    .insertInto("users")
    .values({
      id: idToBytes(userId),
      status: "active",
      username: "environment-test",
      display_name: "Environment Test",
      is_instance_admin: 0,
      created_at: now,
      deleted_at: null,
    })
    .execute();
  await database.db
    .insertInto("sessions")
    .values(
      [firstSessionId, secondSessionId].map((sessionId) => ({
        id: idToBytes(sessionId),
        user_id: idToBytes(userId),
        family_id: idToBytes(createEntityId()),
        status: "active" as const,
        created_at: now,
        last_seen_at: now,
        absolute_expires_at: now + 60_000,
      })),
    )
    .execute();
  const audit = new AuditService(database.db, join(rootPath, "audit"));
  const workspaces = new WorkspaceService(database.db, audit);
  const environments = new EnvironmentService(database.db, workspaces, audit);
  const requests = new RequestService(
    database.db,
    workspaces,
    new VariableService(database.db, workspaces, environments, audit),
    audit,
  );
  const workspace = await workspaces.create(userId, "Workspace");
  return {
    rootPath,
    database,
    audit,
    environments,
    requests,
    userId,
    firstSessionId,
    secondSessionId,
    workspaceId: workspace.workspaceId,
  } satisfies {
    readonly rootPath: string;
    readonly database: SqliteDatabase;
    readonly audit: AuditService;
    readonly environments: EnvironmentService;
    readonly requests: RequestService;
    readonly userId: EntityId;
    readonly firstSessionId: EntityId;
    readonly secondSessionId: EntityId;
    readonly workspaceId: EntityId;
  };
}
