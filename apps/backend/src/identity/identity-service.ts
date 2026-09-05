import type {
  AuthProviderAssertion,
  AuthProviderInput,
} from "@apinteract/plugin-api/backend/authentication";
import type { Kysely } from "kysely";

import type { AuditService } from "../audit/audit-service.js";
import type { AuthProviderRegistry } from "../authentication/auth-provider-registry.js";
import type { CredentialRepository } from "../authentication/credential-repository.js";
import {
  bytesToId,
  createEntityId,
  idToBytes,
  type EntityId,
} from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";

export interface ApplicationUser {
  readonly id: EntityId;
  readonly username: string;
  readonly displayName: string;
  readonly isInstanceAdmin: boolean;
}

export class InstanceAlreadyInitializedError extends Error {}
export class AuthenticationFailedError extends Error {}

const INITIALIZATION_MARKER = "instance_administrator_initialized";

/**
 * Owns application users and provider-subject linkage.
 *
 * Providers prove a scoped subject and own credential material. This service
 * selects neither authentication behavior nor session policy.
 */
export class IdentityService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #audit: AuditService;
  readonly #providers: AuthProviderRegistry;
  readonly #credentials: CredentialRepository;

  constructor(
    database: Kysely<DatabaseSchema>,
    audit: AuditService,
    providers: AuthProviderRegistry,
    credentials: CredentialRepository,
  ) {
    this.#database = database;
    this.#audit = audit;
    this.#providers = providers;
    this.#credentials = credentials;
  }

  /** Creates the first user and one provider-managed administrator credential. */
  async initializeAdministrator(
    username: string,
    displayName: string,
    providerInstanceId: string,
    credentialInput: AuthProviderInput,
  ): Promise<ApplicationUser> {
    const provider = this.#providers.require(providerInstanceId);
    const manager = provider.runtime.credentials;
    if (manager === undefined) {
      throw new Error(
        `Authentication provider ${providerInstanceId} cannot create credentials`,
      );
    }
    const creation = await manager.create(credentialInput);
    const userId = createEntityId();
    const credentialId = createEntityId();
    const now = Date.now();

    return this.#database.transaction().execute(async (transaction) => {
      const claimed = await transaction
        .insertInto("instance_metadata")
        .values({ key: INITIALIZATION_MARKER, value: String(now) })
        .onConflict((conflict) => conflict.column("key").doNothing())
        .executeTakeFirst();
      if (claimed.numInsertedOrUpdatedRows !== 1n) {
        throw new InstanceAlreadyInitializedError(
          "The APInteract instance is already initialized",
        );
      }
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
      await this.#credentials.insert(
        transaction,
        credentialId,
        userId,
        providerInstanceId,
        creation,
        now,
      );
      await this.#audit.record(transaction, {
        type: "identity.instance_administrator_initialized",
        actorUserId: userId,
        workspaceId: null,
        data: { username, providerInstanceId },
      });
      return {
        id: userId,
        username,
        displayName,
        isInstanceAdmin: true,
      };
    });
  }

  /** Reports whether any application user permanently closes first-user setup. */
  async isInitialized(): Promise<boolean> {
    const existing = await this.#database
      .selectFrom("users")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    return Number(existing.count) !== 0;
  }

  /** Resolves a validated provider assertion to one active application user. */
  async resolveAssertion(
    assertion: AuthProviderAssertion,
  ): Promise<ApplicationUser> {
    this.#providers.require(assertion.providerInstanceId);
    const userId = await this.#credentials.resolveUser(
      assertion.providerInstanceId,
      assertion.subject,
    );
    if (userId === null) {
      throw new AuthenticationFailedError(
        "The supplied credentials could not be accepted",
      );
    }
    const user = await this.getActiveUser(userId);
    if (user === undefined) {
      throw new AuthenticationFailedError(
        "The supplied credentials could not be accepted",
      );
    }
    return user;
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

  /** Replaces provider-owned credential material and revokes active sessions. */
  async updateCredential(
    username: string,
    providerInstanceId: string,
    input: AuthProviderInput,
  ): Promise<void> {
    const provider = this.#providers.require(providerInstanceId);
    const manager = provider.runtime.credentials;
    if (manager === undefined) {
      throw new Error(
        `Authentication provider ${providerInstanceId} cannot update credentials`,
      );
    }
    const user = await this.#database
      .selectFrom("users")
      .selectAll()
      .where("username", "=", username)
      .where("status", "!=", "deleted")
      .executeTakeFirstOrThrow();
    const userId = bytesToId(user.id);
    const current = await this.#credentials.forUser(userId, providerInstanceId);
    if (current === null) {
      throw new Error(
        `The user has no credential for authentication provider ${providerInstanceId}`,
      );
    }
    const replacement = await manager.update(current, input);
    await this.#database.transaction().execute(async (transaction) => {
      await this.#credentials.replace(
        transaction,
        current,
        providerInstanceId,
        replacement,
      );
      await transaction
        .updateTable("sessions")
        .set({ status: "revoked" })
        .where("user_id", "=", user.id)
        .where("status", "=", "active")
        .execute();
      await this.#audit.record(transaction, {
        type: "identity.credential_recovered",
        actorUserId: userId,
        workspaceId: null,
        data: { username, providerInstanceId },
      });
    });
  }
}
