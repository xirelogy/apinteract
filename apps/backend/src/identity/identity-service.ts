import type { Kysely } from "kysely";

import type { AuditService } from "../audit/audit-service.js";
import {
  bytesToId,
  createEntityId,
  idToBytes,
  type EntityId,
} from "../foundation/id.js";
import { hashPassword, verifyPassword } from "../foundation/password.js";
import type { DatabaseSchema } from "../persistence/schema.js";

export interface ApplicationUser {
  readonly id: EntityId;
  readonly username: string;
  readonly displayName: string;
  readonly isInstanceAdmin: boolean;
}

export class InstanceAlreadyInitializedError extends Error {}
export class AuthenticationFailedError extends Error {}

/**
 * Owns application users and the built-in local-password credential adapter.
 *
 * Credentials identify and link to users but do not own application sessions;
 * SessionService takes over only after this service returns a verified user.
 */
export class IdentityService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #audit: AuditService;

  constructor(database: Kysely<DatabaseSchema>, audit: AuditService) {
    this.#database = database;
    this.#audit = audit;
  }

  /** Creates the first user and its local-password administrator credential. */
  async initializeAdministrator(
    username: string,
    displayName: string,
    password: string,
  ): Promise<ApplicationUser> {
    const secretHash = await hashPassword(password);
    const userId = createEntityId();
    const credentialId = createEntityId();
    const now = Date.now();

    return this.#database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom("users")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      if (Number(existing.count) !== 0) {
        throw new InstanceAlreadyInitializedError(
          "The APInteract instance is already initialized",
        );
      }

      await transaction
        .insertInto("users")
        .values({
          id: idToBytes(userId),
          status: "active",
          username,
          display_name: displayName,
          is_instance_admin: 1,
          created_at: now,
          deleted_at: null,
        })
        .execute();
      await transaction
        .insertInto("login_credentials")
        .values({
          id: idToBytes(credentialId),
          user_id: idToBytes(userId),
          provider_id: "local-password",
          provider_subject: username,
          secret_hash: secretHash,
          status: "active",
          created_at: now,
        })
        .execute();
      await this.#audit.record(transaction, {
        type: "identity.instance_administrator_initialized",
        actorUserId: userId,
        workspaceId: null,
        data: { username },
      });
      return {
        id: userId,
        username,
        displayName,
        isInstanceAdmin: true,
      };
    });
  }

  /** Verifies an active local-password credential and returns its linked user. */
  async authenticateLocalPassword(
    username: string,
    password: string,
  ): Promise<ApplicationUser> {
    const row = await this.#database
      .selectFrom("login_credentials as credential")
      .innerJoin("users as user", "user.id", "credential.user_id")
      .select([
        "user.id",
        "user.username",
        "user.display_name",
        "user.is_instance_admin",
        "user.status as user_status",
        "credential.secret_hash",
        "credential.status as credential_status",
      ])
      .where("credential.provider_id", "=", "local-password")
      .where("credential.provider_subject", "=", username)
      .executeTakeFirst();

    const valid =
      row !== undefined &&
      row.user_status === "active" &&
      row.credential_status === "active" &&
      (await verifyPassword(password, row.secret_hash));
    if (!valid || row === undefined) {
      throw new AuthenticationFailedError(
        "The supplied credentials could not be accepted",
      );
    }

    return {
      id: bytesToId(row.id),
      username: row.username,
      displayName: row.display_name,
      isInstanceAdmin: row.is_instance_admin === 1,
    };
  }

  /** Returns an active application user by identifier when one exists. */
  async getActiveUser(userId: EntityId): Promise<ApplicationUser | undefined> {
    const row = await this.#database
      .selectFrom("users")
      .selectAll()
      .where("id", "=", idToBytes(userId))
      .where("status", "=", "active")
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          id: bytesToId(row.id),
          username: row.username,
          displayName: row.display_name,
          isInstanceAdmin: row.is_instance_admin === 1,
        };
  }

  /** Replaces a local password and revokes the user's active sessions. */
  async resetPassword(username: string, password: string): Promise<void> {
    const secretHash = await hashPassword(password);
    await this.#database.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom("users")
        .selectAll()
        .where("username", "=", username)
        .where("status", "!=", "deleted")
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("login_credentials")
        .set({ secret_hash: secretHash, status: "active" })
        .where("user_id", "=", user.id)
        .where("provider_id", "=", "local-password")
        .execute();
      await transaction
        .updateTable("sessions")
        .set({ status: "revoked" })
        .where("user_id", "=", user.id)
        .where("status", "=", "active")
        .execute();
      // Credential replacement and session revocation are one recovery action:
      // no session authenticated with the old password survives the reset.
      await this.#audit.record(transaction, {
        type: "identity.password_recovered",
        actorUserId: bytesToId(user.id),
        workspaceId: null,
        data: { username },
      });
    });
  }
}
