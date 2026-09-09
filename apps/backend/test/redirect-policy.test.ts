import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { DEFAULT_COOKIE_POLICY } from "../src/cookies/cookie-policy.js";
import {
  DEFAULT_REDIRECT_POLICY,
  MAX_REDIRECTS_HARD_LIMIT,
  resolveRedirectPolicy,
  UserPreferencesConflictError,
  UserPreferencesService,
  validateRedirectPolicyOverride,
} from "../src/executions/redirect-policy.js";
import { createEntityId, idToBytes } from "../src/foundation/id.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";

describe("HTTP redirect policy", () => {
  it("validates the fixed hard ceiling and rejects unknown fields", () => {
    expect(validateRedirectPolicyOverride({ maxRedirects: 50 })).toEqual({
      maxRedirects: MAX_REDIRECTS_HARD_LIMIT,
    });
    expect(() => validateRedirectPolicyOverride({ maxRedirects: 51 })).toThrow(
      /invalid/u,
    );
    expect(() =>
      validateRedirectPolicyOverride({ follow: true, extra: true } as never),
    ).toThrow(/invalid/u);
  });

  it("resolves request, workspace, user, and packaged values independently", async () => {
    const rootPath = await mkdtemp(
      join(tmpdir(), "apinteract-redirect-policy-"),
    );
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
          username: "redirect-policy-test",
          display_name: "Redirect Policy Test",
          is_instance_admin: 0,
          created_at: Date.now(),
          deleted_at: null,
        })
        .execute();
      const audit = new AuditService(database.db, join(rootPath, "audit"));
      const workspaces = new WorkspaceService(database.db, audit);
      const preferences = new UserPreferencesService(database.db, audit);
      const workspaceSummary = await workspaces.create(userId, "Workspace");
      const workspace = await workspaces.get(
        userId,
        workspaceSummary.workspaceId,
      );

      await expect(preferences.get(userId)).resolves.toEqual({
        redirectPolicy: DEFAULT_REDIRECT_POLICY,
        cookiePolicy: DEFAULT_COOKIE_POLICY,
        cookieConcurrencyMode: "optimistic",
        revision: 0,
      });
      const savedPreferences = await preferences.update(
        userId,
        0,
        {
          follow: false,
          maxRedirects: 7,
        },
        DEFAULT_COOKIE_POLICY,
        "serialized",
      );
      expect(savedPreferences).toMatchObject({
        revision: 1,
        cookieConcurrencyMode: "serialized",
      });
      await expect(
        preferences.update(
          userId,
          0,
          { follow: true, maxRedirects: 10 },
          DEFAULT_COOKIE_POLICY,
          "optimistic",
        ),
      ).rejects.toBeInstanceOf(UserPreferencesConflictError);

      await workspaces.update(
        userId,
        workspace.workspaceId,
        workspace.revision,
        workspace.name,
        workspace.headers,
        workspace.baseUrl,
        workspace.description,
        workspace.notes,
        { maxRedirects: 3 },
      );
      await expect(
        resolveRedirectPolicy(database.db, userId, workspace.workspaceId, {
          follow: true,
        }),
      ).resolves.toEqual({ follow: true, maxRedirects: 3 });
      await expect(
        resolveRedirectPolicy(database.db, userId, workspace.workspaceId, {}),
      ).resolves.toEqual({ follow: false, maxRedirects: 3 });
    } finally {
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
