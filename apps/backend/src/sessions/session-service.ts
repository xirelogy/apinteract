import { createHash, randomBytes } from "node:crypto";

import { jwtVerify, SignJWT } from "jose";
import type { Kysely } from "kysely";

import type { AuditService } from "../audit/audit-service.js";
import {
  bytesToId,
  createEntityId,
  idToBytes,
  type EntityId,
} from "../foundation/id.js";
import type { ApplicationUser } from "../identity/identity-service.js";
import type { DatabaseSchema } from "../persistence/schema.js";

export interface SessionPolicy {
  readonly accessLifetimeSeconds: number;
  readonly refreshIdleLifetimeSeconds: number;
  readonly refreshAbsoluteLifetimeSeconds: number;
}

export interface SessionIdentity {
  readonly sessionId: EntityId;
  readonly user: ApplicationUser;
  readonly createdAt: number;
  readonly absoluteExpiresAt: number;
}

export interface IssuedSession {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: number;
  readonly refreshToken: string;
  readonly identity: SessionIdentity;
}

/** The presented credential cannot establish an active application session. */
export class InvalidSessionError extends Error {}

/**
 * A previously consumed rotating refresh credential was presented again.
 *
 * Detection revokes the owning session before this error is exposed.
 */
export class RefreshTokenReuseError extends Error {}

type RefreshTransactionResult =
  | {
      readonly outcome: "issued";
      readonly identity: SessionIdentity;
    }
  | {
      readonly outcome: "invalid";
      readonly message: string;
    }
  | {
      readonly outcome: "reuse";
    };

/**
 * Owns non-pluggable application sessions after authentication succeeds.
 *
 * Access credentials are short-lived JWTs. Refresh credentials are opaque,
 * stored only as hashes, rotated on every use, and bounded by both idle and
 * absolute lifetimes.
 */
export class SessionService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #audit: AuditService;
  readonly #policy: SessionPolicy;
  #signingKey?: Uint8Array;
  #issuer?: string;

  constructor(
    database: Kysely<DatabaseSchema>,
    audit: AuditService,
    policy: SessionPolicy,
  ) {
    this.#database = database;
    this.#audit = audit;
    this.#policy = policy;
  }

  /** Loads or creates instance signing state and fixes the access-token issuer. */
  async initialize(issuer: string): Promise<void> {
    this.#issuer = issuer;
    // Persisting the instance key keeps access tokens valid across restarts.
    // External key providers and key rotation remain outside the MVP.
    const existing = await this.#database
      .selectFrom("instance_metadata")
      .select("value")
      .where("key", "=", "session_signing_key")
      .executeTakeFirst();
    if (existing === undefined) {
      const encoded = randomBytes(32).toString("base64url");
      await this.#database
        .insertInto("instance_metadata")
        .values({ key: "session_signing_key", value: encoded })
        .execute();
      this.#signingKey = Buffer.from(encoded, "base64url");
    } else {
      this.#signingKey = Buffer.from(existing.value, "base64url");
    }
  }

  /** Creates a session, rotating refresh family, and first access credential. */
  async create(user: ApplicationUser): Promise<IssuedSession> {
    const now = Date.now();
    const sessionId = createEntityId();
    const refreshToken = randomBytes(32).toString("base64url");
    const absoluteExpiresAt =
      now + this.#policy.refreshAbsoluteLifetimeSeconds * 1000;
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("sessions")
        .values({
          id: idToBytes(sessionId),
          user_id: idToBytes(user.id),
          family_id: idToBytes(createEntityId()),
          status: "active",
          created_at: now,
          last_seen_at: now,
          absolute_expires_at: absoluteExpiresAt,
        })
        .execute();
      await transaction
        .insertInto("refresh_tokens")
        .values({
          token_hash: hashToken(refreshToken),
          session_id: idToBytes(sessionId),
          status: "active",
          created_at: now,
          idle_expires_at: now + this.#policy.refreshIdleLifetimeSeconds * 1000,
        })
        .execute();
      await this.#audit.record(transaction, {
        type: "session.created",
        actorUserId: user.id,
        workspaceId: null,
        data: { sessionId },
      });
    });

    return {
      ...(await this.#issueAccessToken(sessionId, user)),
      refreshToken,
      identity: { sessionId, user, createdAt: now, absoluteExpiresAt },
    };
  }

  /**
   * Rotates an active refresh credential and extends its idle lifetime.
   *
   * Reuse commits session revocation before raising RefreshTokenReuseError.
   */
  async refresh(refreshToken: string): Promise<IssuedSession> {
    const now = Date.now();
    const replacement = randomBytes(32).toString("base64url");
    const refreshTokenHash = hashToken(refreshToken);
    const result = await this.#database
      .transaction()
      .execute(async (transaction): Promise<RefreshTransactionResult> => {
        const row = await transaction
          .selectFrom("refresh_tokens as token")
          .innerJoin("sessions as session", "session.id", "token.session_id")
          .innerJoin("users as user", "user.id", "session.user_id")
          .select([
            "token.status as token_status",
            "token.idle_expires_at",
            "session.id as session_id",
            "session.status as session_status",
            "session.created_at",
            "session.absolute_expires_at",
            "user.id as user_id",
            "user.status as user_status",
            "user.username",
            "user.display_name",
            "user.is_instance_admin",
          ])
          .where("token.token_hash", "=", refreshTokenHash)
          .executeTakeFirst();
        if (row === undefined) {
          return {
            outcome: "invalid",
            message: "Refresh credential is invalid",
          };
        }
        if (row.token_status === "consumed") {
          // Reuse implies that either the previous token response was exposed
          // or a stale client retried it. Revoke the entire session before
          // reporting the error so no descendant refresh token remains valid.
          await transaction
            .updateTable("sessions")
            .set({ status: "revoked" })
            .where("id", "=", row.session_id)
            .execute();
          await this.#audit.record(transaction, {
            type: "session.refresh_credential_reused",
            actorUserId: bytesToId(row.user_id),
            workspaceId: null,
            data: { sessionId: bytesToId(row.session_id) },
          });
          return { outcome: "reuse" };
        }
        if (
          row.session_status !== "active" ||
          row.user_status !== "active" ||
          row.idle_expires_at <= now ||
          row.absolute_expires_at <= now
        ) {
          await transaction
            .updateTable("sessions")
            .set({ status: "expired" })
            .where("id", "=", row.session_id)
            .execute();
          return { outcome: "invalid", message: "Session has expired" };
        }

        // Consume and replace in one transaction. A successful refresh can
        // therefore expose only the newly issued opaque credential.
        await transaction
          .updateTable("refresh_tokens")
          .set({ status: "consumed" })
          .where("token_hash", "=", refreshTokenHash)
          .execute();
        await transaction
          .insertInto("refresh_tokens")
          .values({
            token_hash: hashToken(replacement),
            session_id: row.session_id,
            status: "active",
            created_at: now,
            idle_expires_at:
              now + this.#policy.refreshIdleLifetimeSeconds * 1000,
          })
          .execute();
        await transaction
          .updateTable("sessions")
          .set({ last_seen_at: now })
          .where("id", "=", row.session_id)
          .execute();

        return {
          outcome: "issued",
          identity: {
            sessionId: bytesToId(row.session_id),
            createdAt: row.created_at,
            absoluteExpiresAt: row.absolute_expires_at,
            user: {
              id: bytesToId(row.user_id),
              username: row.username,
              displayName: row.display_name,
              isInstanceAdmin: row.is_instance_admin === 1,
            },
          },
        };
      });
    // Security state changes must commit before semantic errors escape the
    // transaction callback; throwing inside it would roll those changes back.
    if (result.outcome === "reuse") {
      throw new RefreshTokenReuseError(
        "A consumed refresh credential was presented",
      );
    }
    if (result.outcome === "invalid") {
      throw new InvalidSessionError(result.message);
    }
    return {
      ...(await this.#issueAccessToken(
        result.identity.sessionId,
        result.identity.user,
      )),
      refreshToken: replacement,
      identity: result.identity,
    };
  }

  /** Verifies JWT claims and rechecks current session and user state. */
  async authenticateAccessToken(token: string): Promise<SessionIdentity> {
    const { payload } = await jwtVerify(token, this.#key(), {
      algorithms: ["HS256"],
      issuer: this.#issuerValue(),
      audience: "apinteract-backend",
    });
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") {
      throw new InvalidSessionError("Access token claims are incomplete");
    }
    // Signature verification is not sufficient for immediate revocation.
    // Re-read session and user state for every authenticated backend operation.
    const row = await this.#database
      .selectFrom("sessions as session")
      .innerJoin("users as user", "user.id", "session.user_id")
      .select([
        "session.id as session_id",
        "session.status as session_status",
        "session.created_at",
        "session.absolute_expires_at",
        "user.id as user_id",
        "user.status as user_status",
        "user.username",
        "user.display_name",
        "user.is_instance_admin",
      ])
      .where("session.id", "=", idToBytes(payload.sid))
      .where("user.id", "=", idToBytes(payload.sub))
      .executeTakeFirst();
    if (
      row === undefined ||
      row.session_status !== "active" ||
      row.user_status !== "active" ||
      row.absolute_expires_at <= Date.now()
    ) {
      throw new InvalidSessionError("Session is not active");
    }
    return {
      sessionId: bytesToId(row.session_id),
      createdAt: row.created_at,
      absoluteExpiresAt: row.absolute_expires_at,
      user: {
        id: bytesToId(row.user_id),
        username: row.username,
        displayName: row.display_name,
        isInstanceAdmin: row.is_instance_admin === 1,
      },
    };
  }

  /** Revokes one session and records the action in the same transaction. */
  async revoke(sessionId: EntityId, actorUserId: EntityId): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("sessions")
        .set({ status: "revoked" })
        .where("id", "=", idToBytes(sessionId))
        .execute();
      await this.#audit.record(transaction, {
        type: "session.revoked",
        actorUserId,
        workspaceId: null,
        data: { sessionId },
      });
    });
  }

  /** Signs a short-lived access JWT for one verified user session. */
  async #issueAccessToken(
    sessionId: EntityId,
    user: ApplicationUser,
  ): Promise<{
    readonly accessToken: string;
    readonly accessTokenExpiresAt: number;
  }> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = nowSeconds + this.#policy.accessLifetimeSeconds;
    const accessToken = await new SignJWT({
      sid: sessionId,
      jti: createEntityId(),
      amr: ["pwd"],
    })
      .setProtectedHeader({ alg: "HS256", kid: "instance-primary" })
      .setIssuer(this.#issuerValue())
      .setAudience("apinteract-backend")
      .setSubject(user.id)
      .setIssuedAt(nowSeconds)
      .setNotBefore(nowSeconds)
      .setExpirationTime(expiresAt)
      .sign(this.#key());
    return {
      accessToken,
      accessTokenExpiresAt: expiresAt * 1000,
    };
  }

  /** Returns initialized signing key material or rejects premature use. */
  #key(): Uint8Array {
    if (this.#signingKey === undefined) {
      throw new Error("SessionService.initialize must be called first");
    }
    return this.#signingKey;
  }

  /** Returns the configured token issuer or rejects premature use. */
  #issuerValue(): string {
    if (this.#issuer === undefined) {
      throw new Error("SessionService.initialize must be called first");
    }
    return this.#issuer;
  }
}

/** Produces the irreversible database lookup key for an opaque refresh token. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
