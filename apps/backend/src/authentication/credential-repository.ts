import type {
  AuthProviderCredentialCreation,
  AuthProviderCredentialReader,
  AuthProviderStoredCredential,
  AuthProviderValue,
} from "@apinteract/plugin-api/backend/authentication";
import type { Kysely, Transaction } from "kysely";

import { bytesToId, idToBytes, type EntityId } from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";
import { validateProviderValue } from "./provider-value.js";

/** Includes core identity needed to replace one linked provider credential. */
export interface LinkedProviderCredential extends AuthProviderStoredCredential {
  readonly credentialId: EntityId;
  readonly userId: EntityId;
}

/** Owns provider-scoped credential persistence and lookup isolation. */
export class CredentialRepository {
  readonly #database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }

  /** Creates a read-only provider view permanently scoped to one instance. */
  reader(providerInstanceId: string): AuthProviderCredentialReader {
    return {
      findByLookupKey: (key, normalizedValue) =>
        this.#findByLookupKey(providerInstanceId, key, normalizedValue),
    };
  }

  /** Resolves an active subject link to its active core user identifier. */
  async resolveUser(
    providerInstanceId: string,
    subject: string,
  ): Promise<EntityId | null> {
    const row = await this.#database
      .selectFrom("login_credentials as credential")
      .innerJoin("users as user", "user.id", "credential.user_id")
      .select("user.id")
      .where("credential.provider_instance_id", "=", providerInstanceId)
      .where("credential.provider_subject", "=", subject)
      .where("credential.status", "=", "active")
      .where("user.status", "=", "active")
      .executeTakeFirst();
    return row === undefined ? null : bytesToId(row.id);
  }

  /** Loads one user's active credential for a selected provider instance. */
  async forUser(
    userId: EntityId,
    providerInstanceId: string,
  ): Promise<LinkedProviderCredential | null> {
    const row = await this.#database
      .selectFrom("login_credentials as credential")
      .innerJoin(
        "provider_credential_material as material",
        "material.credential_id",
        "credential.id",
      )
      .select([
        "credential.id",
        "credential.user_id",
        "credential.provider_subject",
        "material.schema_version",
        "material.data_json",
      ])
      .where("credential.user_id", "=", idToBytes(userId))
      .where("credential.provider_instance_id", "=", providerInstanceId)
      .where("credential.status", "=", "active")
      .executeTakeFirst();
    return row === undefined
      ? null
      : {
          credentialId: bytesToId(row.id),
          userId: bytesToId(row.user_id),
          subject: row.provider_subject,
          material: {
            schemaVersion: row.schema_version,
            data: parseProviderValue(row.data_json),
          },
        };
  }

  /** Inserts one core link plus all provider-owned material atomically. */
  async insert(
    transaction: Transaction<DatabaseSchema>,
    credentialId: EntityId,
    userId: EntityId,
    providerInstanceId: string,
    creation: AuthProviderCredentialCreation,
    createdAt: number,
  ): Promise<void> {
    validateCredentialCreation(creation);
    await transaction
      .insertInto("login_credentials")
      .values({
        id: idToBytes(credentialId),
        user_id: idToBytes(userId),
        provider_instance_id: providerInstanceId,
        provider_subject: creation.subject,
        status: "active",
        created_at: createdAt,
      })
      .execute();
    await transaction
      .insertInto("provider_credential_material")
      .values({
        credential_id: idToBytes(credentialId),
        schema_version: creation.material.schemaVersion,
        data_json: JSON.stringify(creation.material.data),
      })
      .execute();
    await this.#replaceLookupKeys(
      transaction,
      credentialId,
      providerInstanceId,
      creation.lookupKeys,
    );
  }

  /** Replaces provider material and lookup identifiers without changing linkage. */
  async replace(
    transaction: Transaction<DatabaseSchema>,
    current: LinkedProviderCredential,
    providerInstanceId: string,
    creation: AuthProviderCredentialCreation,
  ): Promise<void> {
    validateCredentialCreation(creation);
    if (creation.subject !== current.subject) {
      throw new Error("Credential updates cannot change the provider subject");
    }
    await transaction
      .updateTable("provider_credential_material")
      .set({
        schema_version: creation.material.schemaVersion,
        data_json: JSON.stringify(creation.material.data),
      })
      .where("credential_id", "=", idToBytes(current.credentialId))
      .executeTakeFirstOrThrow();
    await transaction
      .deleteFrom("provider_credential_lookup_keys")
      .where("credential_id", "=", idToBytes(current.credentialId))
      .execute();
    await this.#replaceLookupKeys(
      transaction,
      current.credentialId,
      providerInstanceId,
      creation.lookupKeys,
    );
  }

  /** Finds material without revealing core user or persistence identifiers. */
  async #findByLookupKey(
    providerInstanceId: string,
    key: string,
    normalizedValue: string,
  ): Promise<AuthProviderStoredCredential | null> {
    const row = await this.#database
      .selectFrom("provider_credential_lookup_keys as lookup")
      .innerJoin(
        "login_credentials as credential",
        "credential.id",
        "lookup.credential_id",
      )
      .innerJoin(
        "provider_credential_material as material",
        "material.credential_id",
        "credential.id",
      )
      .select([
        "credential.provider_subject",
        "material.schema_version",
        "material.data_json",
      ])
      .where("lookup.provider_instance_id", "=", providerInstanceId)
      .where("lookup.key_name", "=", key)
      .where("lookup.normalized_value", "=", normalizedValue)
      .where("credential.status", "=", "active")
      .executeTakeFirst();
    return row === undefined
      ? null
      : {
          subject: row.provider_subject,
          material: {
            schemaVersion: row.schema_version,
            data: parseProviderValue(row.data_json),
          },
        };
  }

  /** Inserts unique, non-empty lookup identifiers for one credential. */
  async #replaceLookupKeys(
    transaction: Transaction<DatabaseSchema>,
    credentialId: EntityId,
    providerInstanceId: string,
    keys: readonly { readonly key: string; readonly value: string }[],
  ): Promise<void> {
    if (
      keys.length === 0 ||
      keys.some(({ key, value }) => key.length === 0 || value.length === 0) ||
      new Set(keys.map(({ key }) => key)).size !== keys.length
    ) {
      throw new Error("Provider credential lookup keys are invalid");
    }
    await transaction
      .insertInto("provider_credential_lookup_keys")
      .values(
        keys.map(({ key, value }) => ({
          credential_id: idToBytes(credentialId),
          provider_instance_id: providerInstanceId,
          key_name: key,
          normalized_value: value,
        })),
      )
      .execute();
  }
}

/** Parses trusted persisted JSON while retaining the plugin API boundary type. */
function parseProviderValue(value: string): AuthProviderValue {
  return JSON.parse(value) as AuthProviderValue;
}

/** Validates bounded provider-owned material before it enters core storage. */
function validateCredentialCreation(
  creation: AuthProviderCredentialCreation,
): void {
  if (
    !isRecord(creation) ||
    typeof creation.subject !== "string" ||
    creation.subject.length === 0 ||
    creation.subject.length > 500 ||
    !Array.isArray(creation.lookupKeys) ||
    creation.lookupKeys.length === 0 ||
    creation.lookupKeys.length > 32 ||
    creation.lookupKeys.some(
      (lookup) =>
        !isRecord(lookup) ||
        typeof lookup.key !== "string" ||
        lookup.key.length === 0 ||
        lookup.key.length > 100 ||
        typeof lookup.value !== "string" ||
        lookup.value.length === 0 ||
        lookup.value.length > 500,
    ) ||
    !isRecord(creation.material) ||
    !Number.isSafeInteger(creation.material.schemaVersion) ||
    creation.material.schemaVersion < 1 ||
    !("data" in creation.material)
  ) {
    throw new Error("Provider credential material is invalid");
  }
  validateProviderValue(
    creation.material.data,
    "Authentication provider credential material",
  );
}

/** Narrows untrusted provider output to a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
