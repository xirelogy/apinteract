import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import {
  EnvironmentCompositionCycleError,
  EnvironmentCompositionInvalidError,
  EnvironmentConflictError,
  EnvironmentInUseError,
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
import {
  ResourceNotFoundError,
  WorkspaceService,
} from "../src/workspaces/workspace-service.js";

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
        [],
        "Development services",
        "# Local environment\n\nShared development credentials.",
      );
      expect(first).toMatchObject({
        description: "Development services",
        notes: "# Local environment\n\nShared development credentials.",
      });
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
        undefined,
        "Updated development services",
        "Use this environment for local work.",
      );
      expect(preserved.name).toBe("DEVELOPMENT");
      expect(preserved).toMatchObject({
        description: "Updated development services",
        notes: "Use this environment for local work.",
      });
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

  it("composes ordered nested environments and rejects cycles and dependent deletion", async () => {
    const fixture = await createFixture(roots);
    try {
      const shared = await fixture.environments.create(
        fixture.userId,
        fixture.workspaceId,
        "Shared",
        [
          { name: "diamond", kind: "value", value: "shared" },
          { name: "sharedOnly", kind: "value", value: "available" },
        ],
      );
      const first = await fixture.environments.create(
        fixture.userId,
        fixture.workspaceId,
        "First",
        [
          { name: "winner", kind: "value", value: "first" },
          { name: "diamond", kind: "value", value: "first" },
        ],
        [shared.environmentId],
      );
      const second = await fixture.environments.create(
        fixture.userId,
        fixture.workspaceId,
        "Second",
        [
          { name: "winner", kind: "value", value: "second" },
          { name: "secondOnly", kind: "value", value: "available" },
        ],
        [shared.environmentId],
      );
      const composed = await fixture.environments.create(
        fixture.userId,
        fixture.workspaceId,
        "Composed",
        [{ name: "winner", kind: "value", value: "local" }],
        [first.environmentId, second.environmentId],
      );

      expect(composed.includedEnvironments).toEqual([
        {
          environmentId: first.environmentId,
          name: "First",
          revision: 0,
        },
        {
          environmentId: second.environmentId,
          name: "Second",
          revision: 0,
        },
      ]);
      expect(
        composed.inheritedVariables.map(({ variable, source }) => ({
          name: variable.name,
          source: source.scopeName,
          value: variable.kind === "value" ? variable.value : null,
        })),
      ).toEqual(
        expect.arrayContaining([
          { name: "winner", source: "Second", value: "second" },
          { name: "diamond", source: "Shared", value: "shared" },
          { name: "sharedOnly", source: "Shared", value: "available" },
          { name: "secondOnly", source: "Second", value: "available" },
        ]),
      );

      await fixture.environments.select(
        fixture.userId,
        fixture.firstSessionId,
        fixture.workspaceId,
        composed.environmentId,
      );
      const selected = await fixture.environments.selectedProfile(
        fixture.database.db,
        fixture.firstSessionId,
        fixture.workspaceId,
      );
      expect(
        selected?.variables.map((variable) => [
          variable.name,
          variable.kind === "value" ? variable.value : variable.kind,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["winner", "local"],
          ["diamond", "shared"],
          ["sharedOnly", "available"],
          ["secondOnly", "available"],
        ]),
      );
      expect(selected?.evidence.map((source) => source.environmentId)).toEqual([
        first.environmentId,
        shared.environmentId,
        second.environmentId,
        composed.environmentId,
      ]);
      const effective = await fixture.variables.effectiveProfile(
        fixture.database.db,
        fixture.firstSessionId,
        fixture.workspaceId,
        null,
        null,
      );
      expect(
        effective.evidence
          .filter((entry) => entry.scope === "environment")
          .map((entry) => entry.scopeId),
      ).toEqual([
        first.environmentId,
        shared.environmentId,
        second.environmentId,
        composed.environmentId,
      ]);

      await expect(
        fixture.environments.update(
          fixture.userId,
          shared.environmentId,
          shared.revision,
          shared.name,
          [
            { name: "diamond", kind: "value", value: "shared" },
            { name: "sharedOnly", kind: "value", value: "available" },
          ],
          [composed.environmentId],
        ),
      ).rejects.toBeInstanceOf(EnvironmentCompositionCycleError);
      await expect(
        fixture.environments.update(
          fixture.userId,
          composed.environmentId,
          composed.revision,
          composed.name,
          [{ name: "winner", kind: "value", value: "local" }],
          [first.environmentId, first.environmentId],
        ),
      ).rejects.toBeInstanceOf(EnvironmentCompositionInvalidError);
      await expect(
        fixture.environments.update(
          fixture.userId,
          composed.environmentId,
          composed.revision,
          composed.name,
          [{ name: "winner", kind: "value", value: "local" }],
          [composed.environmentId],
        ),
      ).rejects.toBeInstanceOf(EnvironmentCompositionCycleError);
      const otherWorkspace = await fixture.workspaces.create(
        fixture.userId,
        "Other workspace",
      );
      const foreign = await fixture.environments.create(
        fixture.userId,
        otherWorkspace.workspaceId,
        "Foreign",
        [],
      );
      await expect(
        fixture.environments.update(
          fixture.userId,
          composed.environmentId,
          composed.revision,
          composed.name,
          [{ name: "winner", kind: "value", value: "local" }],
          [foreign.environmentId],
        ),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(
        fixture.environments.delete(
          fixture.userId,
          shared.environmentId,
          shared.revision,
        ),
      ).rejects.toBeInstanceOf(EnvironmentInUseError);

      const reordered = await fixture.environments.update(
        fixture.userId,
        composed.environmentId,
        composed.revision,
        composed.name,
        [],
        [second.environmentId, first.environmentId],
      );
      const reorderedProfile = await fixture.environments.selectedProfile(
        fixture.database.db,
        fixture.firstSessionId,
        fixture.workspaceId,
      );
      expect(
        reordered.includedEnvironments.map(
          ({ environmentId }) => environmentId,
        ),
      ).toEqual([second.environmentId, first.environmentId]);
      expect(
        reorderedProfile?.variables.find(
          (variable) => variable.name === "winner",
        ),
      ).toMatchObject({ kind: "value", value: "first" });
      expect(
        reorderedProfile?.variables.find(
          (variable) => variable.name === "diamond",
        ),
      ).toMatchObject({ kind: "value", value: "first" });
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
  return {
    rootPath,
    database,
    audit,
    environments,
    workspaces,
    variables,
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
    readonly workspaces: WorkspaceService;
    readonly variables: VariableService;
    readonly requests: RequestService;
    readonly userId: EntityId;
    readonly firstSessionId: EntityId;
    readonly secondSessionId: EntityId;
    readonly workspaceId: EntityId;
  };
}
