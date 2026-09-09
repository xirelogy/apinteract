import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import {
  CookieJarService,
  type CookieJarIdentity,
} from "../src/cookies/cookie-jar-service.js";
import { isPublicSuffix } from "../src/cookies/public-suffix-list.js";
import { EnvironmentService } from "../src/environments/environment-service.js";
import { createEntityId, idToBytes } from "../src/foundation/id.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";

describe("cookie jar service", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("stores valid fields atomically and selects matching cookies", async () => {
    const fixture = await createFixture(roots);
    try {
      const executionId = createEntityId();
      const lease = await fixture.cookies.acquire(
        fixture.identity,
        executionId,
        Date.now() + 5_000,
        "optimistic",
      );
      await fixture.cookies.applyResponse(
        fixture.userId,
        executionId,
        fixture.identity,
        lease.jarId,
        "https://api.example.co.uk/account/login",
        [
          "session=abc; Path=/account; Secure; HttpOnly; SameSite=Strict",
          "domain=shared; Domain=example.co.uk; Path=/",
          "suffix=rejected; Domain=co.uk; Path=/",
          "malformed",
        ],
        lease,
      );

      await expect(
        fixture.cookies.cookieHeader(
          lease.jarId,
          "https://api.example.co.uk/account/profile",
          lease,
        ),
      ).resolves.toBe("session=abc; domain=shared");
      await expect(
        fixture.cookies.cookieHeader(
          lease.jarId,
          "http://api.example.co.uk/account/profile",
          lease,
        ),
      ).resolves.toBe("domain=shared");

      await fixture.cookies.applyResponse(
        fixture.userId,
        executionId,
        fixture.identity,
        lease.jarId,
        "http://api.example.co.uk/account/login",
        ["session=shadowed; Path=/account; Max-Age=0"],
        lease,
      );
      await expect(
        fixture.cookies.cookieHeader(
          lease.jarId,
          "https://api.example.co.uk/account/profile",
          lease,
        ),
      ).resolves.toBe("session=abc; domain=shared");
      await expect(
        fixture.cookies.cookieHeader(
          lease.jarId,
          "https://api.example.co.uk/other",
          lease,
        ),
      ).resolves.toBe("domain=shared");

      const view = await fixture.cookies.getActive(
        fixture.userId,
        fixture.sessionId,
        fixture.workspaceId,
      );
      expect(view.cookies).toHaveLength(2);
      expect(view.cookies[0]).toMatchObject({
        name: "session",
        value: "abc",
        hostOnly: true,
        secure: true,
        httpOnly: true,
        sameSite: "strict",
        session: true,
      });
      await lease.release();
    } finally {
      await fixture.database.close();
    }
  });

  it("partitions environment state and clears only session cookies", async () => {
    const fixture = await createFixture(roots);
    try {
      const environment = await fixture.environments.create(
        fixture.userId,
        fixture.workspaceId,
        "Development",
        [],
      );
      const environmentIdentity: CookieJarIdentity = {
        workspaceId: fixture.workspaceId,
        environmentId: environment.environmentId,
      };
      const executionId = createEntityId();
      const lease = await fixture.cookies.acquire(
        environmentIdentity,
        executionId,
        Date.now() + 5_000,
        "optimistic",
      );
      await fixture.cookies.applyResponse(
        fixture.userId,
        executionId,
        environmentIdentity,
        lease.jarId,
        "https://example.test/",
        [
          "session=temporary; Path=/",
          "persistent=retained; Path=/; Max-Age=3600",
        ],
        lease,
      );
      await fixture.environments.select(
        fixture.userId,
        fixture.sessionId,
        fixture.workspaceId,
        environment.environmentId,
      );
      const selected = await fixture.cookies.getActive(
        fixture.userId,
        fixture.sessionId,
        fixture.workspaceId,
      );
      expect(selected.environmentId).toBe(environment.environmentId);
      expect(selected.cookies).toHaveLength(2);
      const cleared = await fixture.cookies.clear(
        fixture.userId,
        environmentIdentity,
        selected.revision,
        "session",
      );
      expect(cleared.cookies.map((cookie) => cookie.name)).toEqual([
        "persistent",
      ]);

      const shared = await fixture.environments.update(
        fixture.userId,
        environment.environmentId,
        environment.revision,
        environment.name,
        [],
        undefined,
        environment.description,
        environment.notes,
        "workspace",
      );
      await expect(
        fixture.cookies.getActive(
          fixture.userId,
          fixture.sessionId,
          fixture.workspaceId,
        ),
      ).resolves.toMatchObject({ environmentId: null, cookies: [] });

      await fixture.environments.update(
        fixture.userId,
        environment.environmentId,
        shared.revision,
        shared.name,
        [],
        undefined,
        shared.description,
        shared.notes,
        "environment",
      );
      await expect(
        fixture.cookies.getActive(
          fixture.userId,
          fixture.sessionId,
          fixture.workspaceId,
        ),
      ).resolves.toMatchObject({
        environmentId: environment.environmentId,
        cookies: [expect.objectContaining({ name: "persistent" })],
      });

      await fixture.environments.select(
        fixture.userId,
        fixture.sessionId,
        fixture.workspaceId,
        null,
      );
      await expect(
        fixture.cookies.getActive(
          fixture.userId,
          fixture.sessionId,
          fixture.workspaceId,
        ),
      ).resolves.toMatchObject({ environmentId: null, cookies: [] });
      await lease.release();
    } finally {
      await fixture.database.close();
    }
  });

  it("queues serialized executions until the current lease is finalized", async () => {
    const fixture = await createFixture(roots);
    try {
      const first = await fixture.cookies.acquire(
        fixture.identity,
        createEntityId(),
        Date.now() + 5_000,
        "serialized",
      );
      let secondAcquired = false;
      const secondPromise = fixture.cookies
        .acquire(
          fixture.identity,
          createEntityId(),
          Date.now() + 5_000,
          "serialized",
        )
        .then((lease) => {
          secondAcquired = true;
          return lease;
        });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(secondAcquired).toBe(false);
      await first.release();
      const second = await secondPromise;
      expect(second.mode).toBe("serialized");
      await second.release();
    } finally {
      await fixture.database.close();
    }
  });

  it("gives queued serialized requests exclusive admission across user modes", async () => {
    const fixture = await createFixture(roots);
    try {
      const first = await fixture.cookies.acquire(
        fixture.identity,
        createEntityId(),
        Date.now() + 5_000,
        "optimistic",
      );
      let serializedAcquired = false;
      const serializedPromise = fixture.cookies
        .acquire(
          fixture.identity,
          createEntityId(),
          Date.now() + 5_000,
          "serialized",
        )
        .then((lease) => {
          serializedAcquired = true;
          return lease;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));

      let laterOptimisticAcquired = false;
      const laterOptimisticPromise = fixture.cookies
        .acquire(
          fixture.identity,
          createEntityId(),
          Date.now() + 5_000,
          "optimistic",
        )
        .then((lease) => {
          laterOptimisticAcquired = true;
          return lease;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(serializedAcquired).toBe(false);
      expect(laterOptimisticAcquired).toBe(false);

      await first.release();
      const serialized = await serializedPromise;
      expect(serializedAcquired).toBe(true);
      expect(laterOptimisticAcquired).toBe(false);
      await serialized.release();

      const laterOptimistic = await laterOptimisticPromise;
      expect(laterOptimisticAcquired).toBe(true);
      await laterOptimistic.release();
    } finally {
      await fixture.database.close();
    }
  });

  it("merges optimistic response commits and permits local Secure cookies", async () => {
    const fixture = await createFixture(roots);
    try {
      const first = await fixture.cookies.acquire(
        fixture.identity,
        createEntityId(),
        Date.now() + 5_000,
        "optimistic",
      );
      const second = await fixture.cookies.acquire(
        fixture.identity,
        createEntityId(),
        Date.now() + 5_000,
        "optimistic",
      );
      await Promise.all([
        fixture.cookies.applyResponse(
          fixture.userId,
          createEntityId(),
          fixture.identity,
          first.jarId,
          "https://example.test/",
          ["first=one; Path=/"],
          first,
        ),
        fixture.cookies.applyResponse(
          fixture.userId,
          createEntityId(),
          fixture.identity,
          second.jarId,
          "https://example.test/",
          ["second=two; Path=/"],
          second,
        ),
      ]);
      await fixture.cookies.applyResponse(
        fixture.userId,
        createEntityId(),
        fixture.identity,
        first.jarId,
        "http://127.0.0.1/",
        ["local=allowed; Path=/; Secure", "bad=no; Domain=0.0.1"],
        first,
      );
      await expect(
        fixture.cookies.cookieHeader(
          first.jarId,
          "https://example.test/",
          first,
        ),
      ).resolves.toBe("first=one; second=two");
      await expect(
        fixture.cookies.cookieHeader(first.jarId, "http://127.0.0.1/", first),
      ).resolves.toBe("local=allowed");
      await Promise.all([first.release(), second.release()]);
    } finally {
      await fixture.database.close();
    }
  });

  it("evaluates public suffix wildcard, exception, private, and IDN rules", () => {
    expect(isPublicSuffix("a.ck")).toBe(true);
    expect(isPublicSuffix("www.ck")).toBe(false);
    expect(isPublicSuffix("github.io")).toBe(true);
    expect(isPublicSuffix("公司.cn")).toBe(true);
    expect(isPublicSuffix("example.github.io")).toBe(false);
  });
});

/** Creates one authorized workspace with both cookie partition dependencies. */
async function createFixture(roots: string[]) {
  const root = await mkdtemp(join(tmpdir(), "apinteract-cookies-"));
  roots.push(root);
  const database = await SqliteDatabase.open(join(root, "database.sqlite"));
  const userId = createEntityId();
  await database.db
    .insertInto("users")
    .values({
      id: idToBytes(userId),
      status: "active",
      username: `cookie-${userId}`,
      display_name: "Cookie Test",
      is_instance_admin: 0,
      created_at: Date.now(),
      deleted_at: null,
    })
    .execute();
  const audit = new AuditService(database.db, join(root, "audit"));
  const workspaces = new WorkspaceService(database.db, audit);
  const environments = new EnvironmentService(database.db, workspaces, audit);
  const cookies = new CookieJarService(database.db, workspaces, audit);
  const workspace = await workspaces.create(userId, "Workspace");
  const sessionId = createEntityId();
  await database.db
    .insertInto("sessions")
    .values({
      id: idToBytes(sessionId),
      user_id: idToBytes(userId),
      family_id: idToBytes(createEntityId()),
      status: "active",
      created_at: Date.now(),
      last_seen_at: Date.now(),
      absolute_expires_at: Date.now() + 60_000,
    })
    .execute();
  return {
    database,
    userId,
    sessionId,
    workspaceId: workspace.workspaceId,
    identity: {
      workspaceId: workspace.workspaceId,
      environmentId: null,
    } satisfies CookieJarIdentity,
    environments,
    cookies,
  };
}
