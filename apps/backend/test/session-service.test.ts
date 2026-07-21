import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { createEntityId, idToBytes } from "../src/foundation/id.js";
import type { ApplicationUser } from "../src/identity/identity-service.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import {
  InvalidSessionError,
  RefreshTokenReuseError,
  SessionService,
} from "../src/sessions/session-service.js";

describe("SessionService refresh rotation", () => {
  it("commits session revocation before reporting refresh-token reuse", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "apinteract-session-"));
    const database = await SqliteDatabase.open(
      join(rootPath, "database.sqlite"),
    );

    try {
      const user: ApplicationUser = {
        id: createEntityId(),
        username: "session-test",
        displayName: "Session Test",
        isInstanceAdmin: false,
      };
      await database.db
        .insertInto("users")
        .values({
          id: idToBytes(user.id),
          status: "active",
          username: user.username,
          display_name: user.displayName,
          is_instance_admin: 0,
          created_at: Date.now(),
          deleted_at: null,
        })
        .execute();

      const sessions = new SessionService(
        database.db,
        new AuditService(database.db, join(rootPath, "audit")),
        {
          accessLifetimeSeconds: 300,
          refreshIdleLifetimeSeconds: 3_600,
          refreshAbsoluteLifetimeSeconds: 86_400,
        },
      );
      await sessions.initialize("https://session.test");

      const original = await sessions.create(user);
      const rotated = await sessions.refresh(original.refreshToken);

      await expect(
        sessions.refresh(original.refreshToken),
      ).rejects.toBeInstanceOf(RefreshTokenReuseError);

      const storedSession = await database.db
        .selectFrom("sessions")
        .select("status")
        .where("id", "=", idToBytes(original.identity.sessionId))
        .executeTakeFirstOrThrow();
      expect(storedSession.status).toBe("revoked");
      await expect(
        sessions.authenticateAccessToken(rotated.accessToken),
      ).rejects.toBeInstanceOf(InvalidSessionError);
    } finally {
      await database.close();
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
