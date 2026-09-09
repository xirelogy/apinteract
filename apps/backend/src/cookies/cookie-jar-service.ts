import { isIP } from "node:net";
import { domainToASCII } from "node:url";

import type { Kysely, Transaction } from "kysely";
import {
  Cookie,
  CookieJar,
  canonicalDomain,
  domainMatch,
  pathMatch,
  type SerializedCookie,
} from "tough-cookie";

import type { AuditService } from "../audit/audit-service.js";
import {
  bytesToId,
  createEntityId,
  idToBytes,
  type EntityId,
} from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";
import { ResourceNotFoundError } from "../workspaces/workspace-service.js";
import type { CookieConcurrencyMode } from "./cookie-policy.js";
import { isPublicSuffix } from "./public-suffix-list.js";

export interface CookieJarIdentity {
  readonly workspaceId: EntityId;
  readonly environmentId: EntityId | null;
}

export interface CookieView {
  readonly cookieId: EntityId;
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly hostOnly: boolean;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: "strict" | "lax" | "none" | null;
  readonly expiresAt: string | null;
  readonly session: boolean;
  readonly extensions: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CookieJarView extends CookieJarIdentity {
  readonly jarId: EntityId;
  readonly revision: number;
  readonly cookies: readonly CookieView[];
}

export interface CookieJarLease {
  readonly jarId: EntityId;
  readonly mode: CookieConcurrencyMode;
  assertValid(): void;
  verify(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  ): Promise<void>;
  release(): Promise<void>;
}

interface PersistedCookieRow {
  readonly id: Uint8Array;
  readonly name: string;
  readonly domain: string;
  readonly path: string;
  readonly host_only: 0 | 1;
  readonly secure: 0 | 1;
  readonly http_only: 0 | 1;
  readonly same_site: "strict" | "lax" | "none" | null;
  readonly expires_at: number | null;
  readonly session_only: 0 | 1;
  readonly metadata_json: string;
  readonly payload: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface StoredCookie {
  readonly cookie: Cookie;
  readonly metadata: Omit<SerializedCookie, "value">;
  readonly value: string;
  readonly identity: string;
  readonly expiresAt: number | null;
  readonly session: boolean;
}

export class CookieJarConflictError extends Error {}
export class CookieJarLockTimeoutError extends Error {}
export class CookieJarLeaseLostError extends Error {}

const LEASE_DURATION_MS = 15_000;
const LEASE_HEARTBEAT_MS = 5_000;
const LEASE_POLL_MS = 25;
const OPTIMISTIC_RESPONSE_RETRIES = 8;

/** Owns workspace cookie partitions, RFC processing, and shared admission. */
export class CookieJarService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #workspaces: WorkspaceService;
  readonly #audit: AuditService;

  constructor(
    database: Kysely<DatabaseSchema>,
    workspaces: WorkspaceService,
    audit: AuditService,
  ) {
    this.#database = database;
    this.#workspaces = workspaces;
    this.#audit = audit;
  }

  /** Loads the active jar after requiring authorized workspace visibility. */
  async getActive(
    userId: EntityId,
    sessionId: EntityId,
    workspaceId: EntityId,
  ): Promise<CookieJarView> {
    await this.#workspaces.requireCanRead(this.#database, userId, workspaceId);
    const identity = await this.activeIdentity(sessionId, workspaceId);
    return this.#database.transaction().execute(async (transaction) => {
      const jar = await this.#ensureJar(transaction, identity);
      await this.#removeExpired(transaction, jar.id, jar.revision);
      return this.#view(transaction, identity, bytesToId(jar.id));
    });
  }

  /** Loads one explicitly identified workspace-owned jar for management. */
  async get(
    userId: EntityId,
    identity: CookieJarIdentity,
  ): Promise<CookieJarView> {
    await this.#workspaces.requireCanRead(
      this.#database,
      userId,
      identity.workspaceId,
    );
    return this.#database.transaction().execute(async (transaction) => {
      const jar = await this.#ensureJar(transaction, identity);
      await this.#removeExpired(transaction, jar.id, jar.revision);
      return this.#view(transaction, identity, bytesToId(jar.id));
    });
  }

  /** Resolves the selected environment's configured workspace-owned partition. */
  async activeIdentity(
    sessionId: EntityId,
    workspaceId: EntityId,
  ): Promise<CookieJarIdentity> {
    const selected = await this.#database
      .selectFrom("session_workspace_environments as selection")
      .innerJoin(
        "environments as environment",
        "environment.id",
        "selection.selected_environment_id",
      )
      .select(["environment.id", "environment.cookie_jar_source"])
      .where("selection.session_id", "=", idToBytes(sessionId))
      .where("selection.workspace_id", "=", idToBytes(workspaceId))
      .where("environment.workspace_id", "=", idToBytes(workspaceId))
      .executeTakeFirst();
    return {
      workspaceId,
      environmentId:
        selected === undefined || selected.cookie_jar_source === "workspace"
          ? null
          : bytesToId(selected.id),
    };
  }

  /** Deletes one cookie identity without accepting user-authored replacement data. */
  async deleteCookie(
    userId: EntityId,
    identity: CookieJarIdentity,
    cookieId: EntityId,
    expectedRevision: number,
  ): Promise<CookieJarView> {
    return this.#database.transaction().execute(async (transaction) => {
      await this.#workspaces.requireCanEdit(
        transaction,
        userId,
        identity.workspaceId,
      );
      const jar = await this.#ensureJar(transaction, identity);
      this.#requireRevision(jar.revision, expectedRevision);
      const cookie = await transaction
        .selectFrom("cookie_records")
        .select(["name", "domain", "path"])
        .where("id", "=", idToBytes(cookieId))
        .where("jar_id", "=", jar.id)
        .executeTakeFirst();
      if (cookie === undefined) {
        throw new ResourceNotFoundError("Cookie not found");
      }
      await transaction
        .deleteFrom("cookie_records")
        .where("id", "=", idToBytes(cookieId))
        .where("jar_id", "=", jar.id)
        .execute();
      const revision = await this.#advanceRevision(
        transaction,
        jar.id,
        expectedRevision,
      );
      await this.#recordMutation(
        transaction,
        userId,
        identity,
        bytesToId(jar.id),
        revision,
        "cookie_jar.cookie_deleted",
        [cookie],
      );
      return this.#view(transaction, identity, bytesToId(jar.id));
    });
  }

  /** Clears session cookies or the complete active partition atomically. */
  async clear(
    userId: EntityId,
    identity: CookieJarIdentity,
    expectedRevision: number,
    scope: "session" | "all",
  ): Promise<CookieJarView> {
    return this.#database.transaction().execute(async (transaction) => {
      await this.#workspaces.requireCanEdit(
        transaction,
        userId,
        identity.workspaceId,
      );
      const jar = await this.#ensureJar(transaction, identity);
      this.#requireRevision(jar.revision, expectedRevision);
      let query = transaction
        .selectFrom("cookie_records")
        .select(["name", "domain", "path"])
        .where("jar_id", "=", jar.id);
      if (scope === "session") query = query.where("session_only", "=", 1);
      const removed = await query.execute();
      if (removed.length === 0) {
        return this.#view(transaction, identity, bytesToId(jar.id));
      }
      let deletion = transaction
        .deleteFrom("cookie_records")
        .where("jar_id", "=", jar.id);
      if (scope === "session") {
        deletion = deletion.where("session_only", "=", 1);
      }
      await deletion.execute();
      const revision = await this.#advanceRevision(
        transaction,
        jar.id,
        expectedRevision,
      );
      await this.#recordMutation(
        transaction,
        userId,
        identity,
        bytesToId(jar.id),
        revision,
        scope === "session"
          ? "cookie_jar.session_cleared"
          : "cookie_jar.cleared",
        removed,
      );
      return this.#view(transaction, identity, bytesToId(jar.id));
    });
  }

  /** Acquires the effective optimistic token or serialized fenced lease. */
  async acquire(
    identity: CookieJarIdentity,
    executionId: EntityId,
    deadline: number,
    mode: CookieConcurrencyMode,
  ): Promise<CookieJarLease> {
    const jar = await this.#database
      .transaction()
      .execute(async (transaction) => {
        const current = await this.#ensureJar(transaction, identity);
        const now = Date.now();
        await this.#cleanAdmission(transaction, current.id, now);
        await transaction
          .insertInto("cookie_jar_waiters")
          .values({
            jar_id: current.id,
            execution_id: idToBytes(executionId),
            requested_mode: mode,
            enqueued_at: now,
            expires_at: deadline,
          })
          .onConflict((conflict) => conflict.doNothing())
          .execute();
        return current;
      });
    const jarId = bytesToId(jar.id);
    if (mode === "optimistic") {
      let admitted = false;
      while (!admitted && Date.now() < deadline) {
        admitted = await this.#tryAdmitOptimistic(jar.id, executionId);
        if (!admitted) await delay(LEASE_POLL_MS);
      }
      if (!admitted) {
        await this.#removeWaiter(jar.id, executionId);
        throw new CookieJarLockTimeoutError(
          "The execution timed out while waiting for the cookie jar",
        );
      }
      let released = false;
      return {
        jarId,
        mode: "optimistic",
        assertValid: () => {
          if (Date.now() >= deadline) {
            throw new CookieJarLeaseLostError(
              "The cookie jar admission expired",
            );
          }
        },
        verify: () => {
          if (Date.now() >= deadline) {
            return Promise.reject(
              new CookieJarLeaseLostError("The cookie jar admission expired"),
            );
          }
          return Promise.resolve();
        },
        release: async () => {
          if (released) return;
          released = true;
          await this.#removeWaiter(jar.id, executionId);
        },
      };
    }
    let fence: number | undefined;
    while (fence === undefined && Date.now() < deadline) {
      fence = await this.#tryAcquire(jar.id, executionId, deadline);
      if (fence === undefined) await delay(LEASE_POLL_MS);
    }
    if (fence === undefined) {
      await this.#removeWaiter(jar.id, executionId);
      throw new CookieJarLockTimeoutError(
        "The execution timed out while waiting for the cookie jar",
      );
    }
    let valid = true;
    const heartbeat = setInterval(() => {
      void this.#renew(jar.id, executionId, fence, deadline)
        .then((renewed) => {
          if (!renewed) valid = false;
        })
        .catch(() => {
          valid = false;
        });
    }, LEASE_HEARTBEAT_MS);
    heartbeat.unref();
    let released = false;
    return {
      jarId,
      mode: "serialized",
      assertValid: () => {
        if (!valid || Date.now() >= deadline) {
          valid = false;
          throw new CookieJarLeaseLostError("The cookie jar lease was lost");
        }
      },
      verify: async (database) => {
        if (!valid || Date.now() >= deadline) {
          valid = false;
          throw new CookieJarLeaseLostError("The cookie jar lease was lost");
        }
        const owner = await database
          .selectFrom("cookie_jars")
          .select([
            "lease_owner_execution_id",
            "lease_fence",
            "lease_expires_at",
          ])
          .where("id", "=", jar.id)
          .executeTakeFirstOrThrow();
        if (
          owner.lease_owner_execution_id === null ||
          bytesToId(owner.lease_owner_execution_id) !== executionId ||
          owner.lease_fence !== fence ||
          (owner.lease_expires_at ?? 0) <= Date.now()
        ) {
          valid = false;
          throw new CookieJarLeaseLostError("The cookie jar lease was lost");
        }
      },
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        await this.#database.transaction().execute(async (transaction) => {
          await transaction
            .deleteFrom("cookie_jar_waiters")
            .where("jar_id", "=", jar.id)
            .where("execution_id", "=", idToBytes(executionId))
            .execute();
          await transaction
            .updateTable("cookie_jars")
            .set({
              lease_owner_execution_id: null,
              lease_expires_at: null,
            })
            .where("id", "=", jar.id)
            .where("lease_owner_execution_id", "=", idToBytes(executionId))
            .where("lease_fence", "=", fence)
            .execute();
        });
      },
    };
  }

  /** Selects eligible cookies from one atomic persisted snapshot. */
  async cookieHeader(
    jarId: EntityId,
    url: string,
    lease: CookieJarLease,
  ): Promise<string> {
    lease.assertValid();
    await lease.verify(this.#database);
    const rows = await this.#cookieRows(this.#database, jarId);
    const jar = await cookieJarFromRows(rows);
    return jar.getCookieString(url, { http: true, expire: true });
  }

  /** Applies all valid Set-Cookie operations in one durable transaction. */
  async applyResponse(
    userId: EntityId,
    executionId: EntityId,
    identity: CookieJarIdentity,
    jarId: EntityId,
    sourceUrl: string,
    fields: readonly string[],
    lease: CookieJarLease,
  ): Promise<void> {
    if (fields.length === 0) return;
    lease.assertValid();
    for (let attempt = 0; attempt < OPTIMISTIC_RESPONSE_RETRIES; attempt += 1) {
      try {
        await this.#applyResponseTransaction(
          userId,
          executionId,
          identity,
          jarId,
          sourceUrl,
          fields,
          lease,
        );
        return;
      } catch (error) {
        if (
          !(error instanceof CookieJarConflictError) ||
          lease.mode === "serialized" ||
          attempt === OPTIMISTIC_RESPONSE_RETRIES - 1
        ) {
          throw error;
        }
      }
    }
  }

  /** Applies one response against a fresh snapshot so retries merge by commit order. */
  async #applyResponseTransaction(
    userId: EntityId,
    executionId: EntityId,
    identity: CookieJarIdentity,
    jarId: EntityId,
    sourceUrl: string,
    fields: readonly string[],
    lease: CookieJarLease,
  ): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      await lease.verify(transaction);
      const jarRow = await transaction
        .selectFrom("cookie_jars")
        .selectAll()
        .where("id", "=", idToBytes(jarId))
        .executeTakeFirstOrThrow();
      if (
        bytesToId(jarRow.workspace_id) !== identity.workspaceId ||
        nullableId(jarRow.environment_id) !== identity.environmentId
      ) {
        throw new ResourceNotFoundError("Cookie jar not found");
      }
      const rows = await this.#cookieRows(transaction, jarId);
      const memory = await cookieJarFromRows(rows);
      for (const field of fields) {
        if (
          !acceptableSetCookie(field, sourceUrl) ||
          (await shadowsSecureCookie(memory, field, sourceUrl))
        ) {
          continue;
        }
        await memory.setCookie(field, sourceUrl, {
          http: true,
          ignoreError: true,
        });
      }
      const stored = await storedCookies(memory);
      if (sameCookieState(rows, stored)) return;
      await transaction
        .deleteFrom("cookie_records")
        .where("jar_id", "=", idToBytes(jarId))
        .execute();
      const previous = new Map(
        rows.map((row) => [
          cookieIdentity(row.name, row.domain, row.path),
          row,
        ]),
      );
      const now = Date.now();
      for (const item of stored) {
        const existing = previous.get(item.identity);
        await transaction
          .insertInto("cookie_records")
          .values({
            id: existing?.id ?? idToBytes(createEntityId()),
            jar_id: idToBytes(jarId),
            name: item.cookie.key,
            domain: item.cookie.domain ?? "",
            path: item.cookie.path ?? "/",
            host_only: item.cookie.hostOnly === true ? 1 : 0,
            secure: item.cookie.secure ? 1 : 0,
            http_only: item.cookie.httpOnly ? 1 : 0,
            same_site: normalizedSameSite(item.cookie.sameSite),
            expires_at: item.expiresAt,
            session_only: item.session ? 1 : 0,
            metadata_json: JSON.stringify(item.metadata),
            storage_format: "plaintext-v1",
            payload: item.value,
            created_at: existing?.created_at ?? now,
            updated_at: now,
          })
          .execute();
      }
      const revision = await this.#advanceRevision(
        transaction,
        idToBytes(jarId),
        jarRow.revision,
      );
      await this.#audit.record(transaction, {
        type: "cookie_jar.response_applied",
        actorUserId: userId,
        workspaceId: identity.workspaceId,
        data: {
          jarId,
          environmentId: identity.environmentId,
          executionId,
          revision,
          affected: changedCookieIdentities(rows, stored),
        },
      });
    });
  }

  /** Removes every jar owned by a tombstoned workspace. */
  async deleteWorkspaceJars(
    transaction: Transaction<DatabaseSchema>,
    workspaceId: EntityId,
  ): Promise<void> {
    await transaction
      .deleteFrom("cookie_jars")
      .where("workspace_id", "=", idToBytes(workspaceId))
      .execute();
  }

  /** Creates or returns one partition after validating its workspace owner. */
  async #ensureJar(
    transaction: Transaction<DatabaseSchema>,
    identity: CookieJarIdentity,
  ) {
    if (identity.environmentId !== null) {
      const environment = await transaction
        .selectFrom("environments")
        .select("id")
        .where("id", "=", idToBytes(identity.environmentId))
        .where("workspace_id", "=", idToBytes(identity.workspaceId))
        .executeTakeFirst();
      if (environment === undefined) {
        throw new ResourceNotFoundError("Environment not found");
      }
    }
    const existing = await this.#jarRow(transaction, identity);
    if (existing !== undefined) return existing;
    const now = Date.now();
    await transaction
      .insertInto("cookie_jars")
      .values({
        id: idToBytes(createEntityId()),
        workspace_id: idToBytes(identity.workspaceId),
        environment_id:
          identity.environmentId === null
            ? null
            : idToBytes(identity.environmentId),
        revision: 0,
        lease_owner_execution_id: null,
        lease_fence: 0,
        lease_expires_at: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    const created = await this.#jarRow(transaction, identity);
    if (created === undefined) {
      throw new Error("Cookie jar could not be created");
    }
    return created;
  }

  /** Finds one environment or workspace-default partition. */
  async #jarRow(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    identity: CookieJarIdentity,
  ) {
    let query = database
      .selectFrom("cookie_jars")
      .selectAll()
      .where("workspace_id", "=", idToBytes(identity.workspaceId));
    query =
      identity.environmentId === null
        ? query.where("environment_id", "is", null)
        : query.where("environment_id", "=", idToBytes(identity.environmentId));
    return query.executeTakeFirst();
  }

  /** Returns persisted cookies for one known jar. */
  async #cookieRows(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    jarId: EntityId,
  ): Promise<PersistedCookieRow[]> {
    return database
      .selectFrom("cookie_records")
      .selectAll()
      .where("jar_id", "=", idToBytes(jarId))
      .orderBy("created_at")
      .orderBy("id")
      .execute();
  }

  /** Builds the authorized management projection for one partition. */
  async #view(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    identity: CookieJarIdentity,
    jarId: EntityId,
  ): Promise<CookieJarView> {
    const [jar, cookies] = await Promise.all([
      database
        .selectFrom("cookie_jars")
        .select("revision")
        .where("id", "=", idToBytes(jarId))
        .executeTakeFirstOrThrow(),
      this.#cookieRows(database, jarId),
    ]);
    return {
      ...identity,
      jarId,
      revision: jar.revision,
      cookies: cookies.map(cookieView),
    };
  }

  /** Removes naturally expired records and advances the jar revision once. */
  async #removeExpired(
    transaction: Transaction<DatabaseSchema>,
    jarId: Uint8Array,
    revision: number,
  ): Promise<void> {
    const expired = await transaction
      .selectFrom("cookie_records")
      .select("id")
      .where("jar_id", "=", jarId)
      .where("expires_at", "is not", null)
      .where("expires_at", "<=", Date.now())
      .execute();
    if (expired.length === 0) return;
    await transaction
      .deleteFrom("cookie_records")
      .where("jar_id", "=", jarId)
      .where("expires_at", "is not", null)
      .where("expires_at", "<=", Date.now())
      .execute();
    await this.#advanceRevision(transaction, jarId, revision);
  }

  /** Admits a shared request unless an exclusive lease or earlier writer exists. */
  async #tryAdmitOptimistic(
    jarId: Uint8Array,
    executionId: EntityId,
  ): Promise<boolean> {
    return this.#database.transaction().execute(async (transaction) => {
      const now = Date.now();
      await this.#cleanAdmission(transaction, jarId, now);
      const waiter = await transaction
        .selectFrom("cookie_jar_waiters")
        .select(["enqueued_at", "execution_id"])
        .where("jar_id", "=", jarId)
        .where("execution_id", "=", idToBytes(executionId))
        .executeTakeFirst();
      if (waiter === undefined) return false;
      const jar = await transaction
        .selectFrom("cookie_jars")
        .select(["lease_owner_execution_id", "lease_expires_at"])
        .where("id", "=", jarId)
        .executeTakeFirstOrThrow();
      if (
        jar.lease_owner_execution_id !== null &&
        (jar.lease_expires_at ?? 0) > now
      ) {
        return false;
      }
      const earlierWriter = await transaction
        .selectFrom("cookie_jar_waiters")
        .select("execution_id")
        .where("jar_id", "=", jarId)
        .where("requested_mode", "=", "serialized")
        .where((expression) =>
          expression.or([
            expression("enqueued_at", "<", waiter.enqueued_at),
            expression.and([
              expression("enqueued_at", "=", waiter.enqueued_at),
              expression("execution_id", "<", waiter.execution_id),
            ]),
          ]),
        )
        .executeTakeFirst();
      return earlierWriter === undefined;
    });
  }

  /** Acquires an exclusive lease only for the oldest queued execution. */
  async #tryAcquire(
    jarId: Uint8Array,
    executionId: EntityId,
    deadline: number,
  ): Promise<number | undefined> {
    return this.#database.transaction().execute(async (transaction) => {
      const now = Date.now();
      await this.#cleanAdmission(transaction, jarId, now);
      const first = await transaction
        .selectFrom("cookie_jar_waiters")
        .select(["execution_id", "requested_mode"])
        .where("jar_id", "=", jarId)
        .orderBy("enqueued_at")
        .orderBy("execution_id")
        .executeTakeFirst();
      if (
        first === undefined ||
        bytesToId(first.execution_id) !== executionId ||
        first.requested_mode !== "serialized"
      ) {
        return undefined;
      }
      const jar = await transaction
        .selectFrom("cookie_jars")
        .select(["lease_owner_execution_id", "lease_fence", "lease_expires_at"])
        .where("id", "=", jarId)
        .executeTakeFirstOrThrow();
      if (
        jar.lease_owner_execution_id !== null &&
        (jar.lease_expires_at ?? 0) > now
      ) {
        return undefined;
      }
      const fence = jar.lease_fence + 1;
      const result = await transaction
        .updateTable("cookie_jars")
        .set({
          lease_owner_execution_id: idToBytes(executionId),
          lease_fence: fence,
          lease_expires_at: Math.min(now + LEASE_DURATION_MS, deadline),
        })
        .where("id", "=", jarId)
        .where("lease_fence", "=", jar.lease_fence)
        .executeTakeFirst();
      return result.numUpdatedRows === 1n ? fence : undefined;
    });
  }

  /** Extends a lease only while its fencing token remains current. */
  async #renew(
    jarId: Uint8Array,
    executionId: EntityId,
    fence: number,
    deadline: number,
  ): Promise<boolean> {
    const now = Date.now();
    if (now >= deadline) return false;
    const result = await this.#database
      .updateTable("cookie_jars")
      .set({
        lease_expires_at: Math.min(now + LEASE_DURATION_MS, deadline),
      })
      .where("id", "=", jarId)
      .where("lease_owner_execution_id", "=", idToBytes(executionId))
      .where("lease_fence", "=", fence)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  /** Removes expired admissions and releases an expired exclusive owner. */
  async #cleanAdmission(
    transaction: Transaction<DatabaseSchema>,
    jarId: Uint8Array,
    now: number,
  ): Promise<void> {
    const jar = await transaction
      .selectFrom("cookie_jars")
      .select(["lease_owner_execution_id", "lease_expires_at"])
      .where("id", "=", jarId)
      .executeTakeFirstOrThrow();
    await transaction
      .deleteFrom("cookie_jar_waiters")
      .where("jar_id", "=", jarId)
      .where("expires_at", "<=", now)
      .execute();
    if (
      jar.lease_owner_execution_id !== null &&
      (jar.lease_expires_at ?? 0) <= now
    ) {
      await transaction
        .deleteFrom("cookie_jar_waiters")
        .where("jar_id", "=", jarId)
        .where("execution_id", "=", jar.lease_owner_execution_id)
        .execute();
      await transaction
        .updateTable("cookie_jars")
        .set({
          lease_owner_execution_id: null,
          lease_expires_at: null,
        })
        .where("id", "=", jarId)
        .where("lease_owner_execution_id", "=", jar.lease_owner_execution_id)
        .execute();
    }
  }

  /** Removes one timed-out serialized waiter. */
  async #removeWaiter(jarId: Uint8Array, executionId: EntityId): Promise<void> {
    await this.#database
      .deleteFrom("cookie_jar_waiters")
      .where("jar_id", "=", jarId)
      .where("execution_id", "=", idToBytes(executionId))
      .execute();
  }

  /** Advances one jar revision or reports a concurrent mutation. */
  async #advanceRevision(
    transaction: Transaction<DatabaseSchema>,
    jarId: Uint8Array,
    expectedRevision: number,
  ): Promise<number> {
    const revision = expectedRevision + 1;
    const result = await transaction
      .updateTable("cookie_jars")
      .set({ revision, updated_at: Date.now() })
      .where("id", "=", jarId)
      .where("revision", "=", expectedRevision)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new CookieJarConflictError("The cookie jar changed");
    }
    return revision;
  }

  /** Rejects stale management commands before any destructive write. */
  #requireRevision(actual: number, expected: number): void {
    if (actual !== expected) {
      throw new CookieJarConflictError("The cookie jar changed");
    }
  }

  /** Records cookie identities without placing credential values in audit data. */
  async #recordMutation(
    transaction: Transaction<DatabaseSchema>,
    userId: EntityId,
    identity: CookieJarIdentity,
    jarId: EntityId,
    revision: number,
    type: string,
    cookies: readonly {
      readonly name: string;
      readonly domain: string;
      readonly path: string;
    }[],
  ): Promise<void> {
    await this.#audit.record(transaction, {
      type,
      actorUserId: userId,
      workspaceId: identity.workspaceId,
      data: {
        jarId,
        environmentId: identity.environmentId,
        revision,
        affected: cookies.map(({ name, domain, path }) => ({
          name,
          domain,
          path,
        })),
      },
    });
  }
}

/** Rehydrates the RFC implementation from one database snapshot. */
async function cookieJarFromRows(
  rows: readonly PersistedCookieRow[],
): Promise<CookieJar> {
  const jar = new CookieJar(undefined, {
    rejectPublicSuffixes: false,
    allowSpecialUseDomain: true,
    allowSecureOnLocal: true,
    prefixSecurity: "silent",
  });
  for (const row of rows) {
    const metadata = JSON.parse(row.metadata_json) as SerializedCookie;
    const cookie = Cookie.fromJSON({ ...metadata, value: row.payload });
    if (cookie !== undefined) await jar.store.putCookie(cookie);
  }
  return jar;
}

/** Converts all in-memory cookies into value-separated durable records. */
async function storedCookies(jar: CookieJar): Promise<StoredCookie[]> {
  const serialized = await jar.serialize();
  const now = new Date();
  return serialized.cookies.flatMap((value) => {
    const cookie = Cookie.fromJSON(value);
    if (
      cookie === undefined ||
      cookie.domain === null ||
      cookie.path === null
    ) {
      return [];
    }
    const expiry = cookie.expiryTime(now);
    if (expiry !== undefined && expiry <= now.valueOf()) return [];
    const { value: payload = "", ...metadata } = cookie.toJSON();
    return [
      {
        cookie,
        metadata,
        value: payload,
        identity: cookieIdentity(cookie.key, cookie.domain, cookie.path),
        expiresAt:
          expiry === undefined || !Number.isFinite(expiry) ? null : expiry,
        session: cookie.expires === "Infinity" && cookie.maxAge === null,
      },
    ];
  });
}

/** Applies explicit PSL, IP, and source-domain acceptance rules. */
function acceptableSetCookie(field: string, sourceUrl: string): boolean {
  const parsed = Cookie.parse(field);
  if (parsed === undefined) return false;
  if (parsed.domain === null) return true;
  const sourceHost = canonicalHost(new URL(sourceUrl).hostname);
  const domain = canonicalHost(parsed.domain);
  return (
    domain !== "" &&
    isIP(sourceHost) === 0 &&
    !isPublicSuffix(domain) &&
    domainMatch(sourceHost, domain, true) === true
  );
}

/** Rejects insecure overlays of an existing Secure cookie per RFC 6265bis. */
async function shadowsSecureCookie(
  jar: CookieJar,
  field: string,
  sourceUrl: string,
): Promise<boolean> {
  const source = new URL(sourceUrl);
  if (isPotentiallyTrustworthy(source)) return false;
  const candidate = Cookie.parse(field);
  if (candidate === undefined || candidate.secure) return false;
  const candidateDomain = canonicalHost(candidate.domain ?? source.hostname);
  const candidatePath =
    candidate.path?.startsWith("/") === true
      ? candidate.path
      : defaultCookiePath(source.pathname);
  const serialized = await jar.serialize();
  return serialized.cookies.some((existing) => {
    const existingDomain = canonicalHost(
      typeof existing.domain === "string" ? existing.domain : "",
    );
    const existingPath =
      typeof existing.path === "string" ? existing.path : "/";
    return (
      existing.secure === true &&
      existing.key === candidate.key &&
      domainMatch(candidateDomain, existingDomain, true) === true &&
      pathMatch(candidatePath, existingPath)
    );
  });
}

/** Applies the browser-compatible trustworthy exception for local targets. */
function isPotentiallyTrustworthy(url: URL): boolean {
  if (url.protocol === "https:" || url.protocol === "wss:") return true;
  const host = canonicalHost(url.hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) {
    return host.split(".")[0] === "127";
  }
  return isIP(host) === 6 && host === "::1";
}

/** Computes the RFC default cookie path from one request path. */
function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const finalSlash = pathname.lastIndexOf("/");
  return finalSlash <= 0 ? "/" : pathname.slice(0, finalSlash);
}

/** Canonicalizes a cookie hostname before security comparisons. */
function canonicalHost(value: string): string {
  const canonical = canonicalDomain(domainToASCII(value));
  return typeof canonical === "string" ? canonical : "";
}

/** Converts one nullable database UUID without changing null identity. */
function nullableId(value: Uint8Array | null): EntityId | null {
  return value === null ? null : bytesToId(value);
}

/** Returns the database identity tuple required by RFC replacement rules. */
function cookieIdentity(name: string, domain: string, path: string): string {
  return `${name}\u0000${domain}\u0000${path}`;
}

/** Normalizes library SameSite metadata to the public contract. */
function normalizedSameSite(
  value: string | undefined,
): "strict" | "lax" | "none" | null {
  const normalized = value?.toLowerCase();
  return normalized === "strict" ||
    normalized === "lax" ||
    normalized === "none"
    ? normalized
    : null;
}

/** Compares credential-bearing state without exposing values outside memory. */
function sameCookieState(
  rows: readonly PersistedCookieRow[],
  stored: readonly StoredCookie[],
): boolean {
  if (rows.length !== stored.length) return false;
  const previous = new Map(
    rows.map((row) => [cookieIdentity(row.name, row.domain, row.path), row]),
  );
  return stored.every((item) => {
    const row = previous.get(item.identity);
    return (
      row !== undefined &&
      row.payload === item.value &&
      row.metadata_json === JSON.stringify(item.metadata)
    );
  });
}

/** Lists changed identities for value-free audit evidence. */
function changedCookieIdentities(
  rows: readonly PersistedCookieRow[],
  stored: readonly StoredCookie[],
): readonly {
  readonly name: string;
  readonly domain: string;
  readonly path: string;
}[] {
  const previous = new Map(
    rows.map((row) => [cookieIdentity(row.name, row.domain, row.path), row]),
  );
  const next = new Map(stored.map((item) => [item.identity, item]));
  const identities = new Set([...previous.keys(), ...next.keys()]);
  return [...identities].flatMap((identity) => {
    const before = previous.get(identity);
    const after = next.get(identity);
    if (
      before !== undefined &&
      after !== undefined &&
      before.payload === after.value &&
      before.metadata_json === JSON.stringify(after.metadata)
    ) {
      return [];
    }
    return [
      after === undefined
        ? { name: before!.name, domain: before!.domain, path: before!.path }
        : {
            name: after.cookie.key,
            domain: after.cookie.domain ?? "",
            path: after.cookie.path ?? "/",
          },
    ];
  });
}

/** Maps one credential row to the explicit authorized management view. */
function cookieView(row: PersistedCookieRow): CookieView {
  const metadata = JSON.parse(row.metadata_json) as SerializedCookie;
  return {
    cookieId: bytesToId(row.id),
    name: row.name,
    value: row.payload,
    domain: row.domain,
    path: row.path,
    hostOnly: row.host_only === 1,
    secure: row.secure === 1,
    httpOnly: row.http_only === 1,
    sameSite: row.same_site,
    expiresAt:
      row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    session: row.session_only === 1,
    extensions: Array.isArray(metadata.extensions)
      ? metadata.extensions.filter(
          (extension): extension is string => typeof extension === "string",
        )
      : [],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Waits briefly before another serialized lease attempt. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
