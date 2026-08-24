import type { Kysely, Transaction } from "kysely";

import { validateFieldDescription } from "../documentation/documentation.js";
import {
  bytesToId,
  createEntityId,
  idToBytes,
  type EntityId,
} from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";
import { ResourceNotFoundError } from "../workspaces/workspace-service.js";

export type VariableScopeKind =
  | "workspace"
  | "collection"
  | "environment"
  | "request";

export type VariableWrite =
  | {
      readonly variableId?: EntityId;
      readonly name: string;
      readonly description?: string;
      readonly kind: "value";
      readonly value: string;
    }
  | {
      readonly variableId?: EntityId;
      readonly name: string;
      readonly description?: string;
      readonly kind: "alias";
      readonly target: string;
    }
  | {
      readonly variableId?: EntityId;
      readonly name: string;
      readonly description?: string;
      readonly kind: "unset";
    }
  | {
      readonly variableId?: EntityId;
      readonly name: string;
      readonly description?: string;
      readonly kind: "secret";
      readonly value?: string;
      readonly clearValue?: boolean;
    };

export type VariableView =
  | {
      readonly variableId: EntityId;
      readonly name: string;
      readonly description: string;
      readonly kind: "value";
      readonly value: string;
    }
  | {
      readonly variableId: EntityId;
      readonly name: string;
      readonly description: string;
      readonly kind: "alias";
      readonly target: string;
    }
  | {
      readonly variableId: EntityId;
      readonly name: string;
      readonly description: string;
      readonly kind: "unset";
    }
  | {
      readonly variableId: EntityId;
      readonly name: string;
      readonly description: string;
      readonly kind: "secret";
      readonly hasValue: boolean;
      readonly secretVersion: number;
    };

export interface ResolvedVariable {
  readonly variableId: EntityId;
  readonly name: string;
  readonly kind: "value" | "secret" | "alias" | "unset";
  readonly value: string | null;
  readonly aliasTarget: string | null;
  readonly secretVersion: number | null;
}

export interface VariableProfileMetadata {
  readonly profileId: EntityId;
  readonly workspaceId: EntityId;
  readonly scopeKind: VariableScopeKind;
  readonly scopeId: EntityId;
  readonly revision: number;
}

export interface SecretMutation {
  readonly type: "created" | "replaced" | "cleared" | "deleted";
  readonly variableId: EntityId;
  readonly version: number;
}

/** Identifies the source, destination, and ownership of one profile clone. */
interface VariableProfileCloneOptions {
  readonly workspaceId: EntityId;
  readonly scopeKind: VariableScopeKind;
  readonly sourceScopeId: EntityId;
  readonly targetScopeId: EntityId;
  readonly userId: EntityId;
}

/** Restricts exceptional secret creation behavior to trusted internal workflows. */
interface VariableProfileCreateOptions {
  readonly allowUnconfiguredSecrets?: boolean;
}

/** Raised when a persisted variable changes kind or a profile revision is stale. */
export class VariableProfileConflictError extends Error {}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;

/**
 * Owns the scope-neutral variable and secret persistence boundary.
 *
 * Secret plaintext is available only from `resolvedVariables`, which callers
 * must restrict to backend composition. Redacted views are safe for CRUD APIs.
 */
export class VariableProfileStore {
  readonly #database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }

  /** Creates one profile and its ordered variables in the caller transaction. */
  async create(
    transaction: Transaction<DatabaseSchema>,
    workspaceId: EntityId,
    scopeKind: VariableScopeKind,
    scopeId: EntityId,
    revision: number,
    userId: EntityId,
    writes: readonly VariableWrite[],
    options: VariableProfileCreateOptions = {},
  ): Promise<SecretMutation[]> {
    const profileId = createEntityId();
    const result = await transaction
      .insertInto("variable_profiles")
      .values({
        id: idToBytes(profileId),
        workspace_id: idToBytes(workspaceId),
        scope_kind: scopeKind,
        scope_id: idToBytes(scopeId),
        revision,
        updated_by: idToBytes(userId),
        updated_at: Date.now(),
      })
      .onConflict((conflict) =>
        conflict.columns(["scope_kind", "scope_id"]).doNothing(),
      )
      .executeTakeFirst();
    if (result.numInsertedOrUpdatedRows !== 1n) {
      throw new VariableProfileConflictError("The variable profile changed");
    }
    return this.#replaceRows(
      transaction,
      profileId,
      writes,
      options.allowUnconfiguredSecrets ?? false,
    );
  }

  /** Clones one profile with fresh variable IDs without exposing secret payloads. */
  async clone(
    transaction: Transaction<DatabaseSchema>,
    options: VariableProfileCloneOptions,
  ): Promise<SecretMutation[] | null> {
    const source = await this.metadata(
      transaction,
      options.scopeKind,
      options.sourceScopeId,
    );
    if (source === null) return null;

    const profileId = createEntityId();
    await transaction
      .insertInto("variable_profiles")
      .values({
        id: idToBytes(profileId),
        workspace_id: idToBytes(options.workspaceId),
        scope_kind: options.scopeKind,
        scope_id: idToBytes(options.targetScopeId),
        revision: 1,
        updated_by: idToBytes(options.userId),
        updated_at: Date.now(),
      })
      .executeTakeFirstOrThrow();
    const variables = await transaction
      .selectFrom("variables as variable")
      .leftJoin(
        "variable_secrets as secret",
        "secret.variable_id",
        "variable.id",
      )
      .select([
        "variable.position",
        "variable.name",
        "variable.description_text",
        "variable.kind",
        "variable.value_text",
        "variable.alias_target",
        "secret.payload",
      ])
      .where("variable.profile_id", "=", idToBytes(source.profileId))
      .orderBy("variable.position")
      .execute();
    const mutations: SecretMutation[] = [];
    for (const variable of variables) {
      const variableId = createEntityId();
      await transaction
        .insertInto("variables")
        .values({
          id: idToBytes(variableId),
          profile_id: idToBytes(profileId),
          position: variable.position,
          name: variable.name,
          description_text: variable.description_text,
          kind: variable.kind,
          value_text: variable.value_text,
          alias_target: variable.alias_target,
        })
        .execute();
      if (variable.kind !== "secret") continue;
      await transaction
        .insertInto("variable_secrets")
        .values({
          variable_id: idToBytes(variableId),
          version: 1,
          storage_format: "plaintext-v1",
          payload: variable.payload,
        })
        .execute();
      mutations.push({ type: "created", variableId, version: 1 });
    }
    return mutations;
  }

  /** Replaces an existing profile and advances its optimistic revision. */
  async replace(
    transaction: Transaction<DatabaseSchema>,
    scopeKind: VariableScopeKind,
    scopeId: EntityId,
    expectedRevision: number,
    userId: EntityId,
    writes: readonly VariableWrite[],
  ): Promise<{
    readonly revision: number;
    readonly mutations: SecretMutation[];
  }> {
    const profile = await this.metadata(transaction, scopeKind, scopeId);
    if (profile === null || profile.revision !== expectedRevision) {
      throw new VariableProfileConflictError("The variable profile changed");
    }
    const revision = expectedRevision + 1;
    const mutations = await this.#replaceRows(
      transaction,
      profile.profileId,
      writes,
      false,
    );
    const result = await transaction
      .updateTable("variable_profiles")
      .set({
        revision,
        updated_by: idToBytes(userId),
        updated_at: Date.now(),
      })
      .where("id", "=", idToBytes(profile.profileId))
      .where("revision", "=", expectedRevision)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new VariableProfileConflictError("The variable profile changed");
    }
    return { revision, mutations };
  }

  /** Returns profile ownership and revision, or null for an empty implicit profile. */
  async metadata(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    scopeKind: VariableScopeKind,
    scopeId: EntityId,
  ): Promise<VariableProfileMetadata | null> {
    const row = await database
      .selectFrom("variable_profiles")
      .select(["id", "workspace_id", "scope_kind", "scope_id", "revision"])
      .where("scope_kind", "=", scopeKind)
      .where("scope_id", "=", idToBytes(scopeId))
      .executeTakeFirst();
    return row === undefined
      ? null
      : {
          profileId: bytesToId(row.id),
          workspaceId: bytesToId(row.workspace_id),
          scopeKind: row.scope_kind,
          scopeId: bytesToId(row.scope_id),
          revision: row.revision,
        };
  }

  /** Returns a profile's ordered variables with every secret value redacted. */
  async redactedVariables(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    scopeKind: VariableScopeKind,
    scopeId: EntityId,
  ): Promise<readonly VariableView[]> {
    const profile = await this.metadata(database, scopeKind, scopeId);
    if (profile === null) {
      return [];
    }
    const rows = await database
      .selectFrom("variables as variable")
      .leftJoin(
        "variable_secrets as secret",
        "secret.variable_id",
        "variable.id",
      )
      .select([
        "variable.id",
        "variable.name",
        "variable.description_text",
        "variable.kind",
        "variable.value_text",
        "variable.alias_target",
        "secret.version",
        "secret.payload",
      ])
      .where("variable.profile_id", "=", idToBytes(profile.profileId))
      .orderBy("variable.position")
      .execute();
    return rows.map((row): VariableView => {
      const common = {
        variableId: bytesToId(row.id),
        name: row.name,
        description: row.description_text,
      };
      switch (row.kind) {
        case "value":
          return { ...common, kind: "value", value: row.value_text ?? "" };
        case "alias":
          return { ...common, kind: "alias", target: row.alias_target ?? "" };
        case "unset":
          return { ...common, kind: "unset" };
        case "secret":
          return {
            ...common,
            kind: "secret",
            hasValue: row.payload !== null,
            secretVersion: row.version ?? 1,
          };
      }
    });
  }

  /** Loads ordered plaintext variables exclusively for backend composition. */
  async resolvedVariables(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    scopeKind: VariableScopeKind,
    scopeId: EntityId,
  ): Promise<readonly ResolvedVariable[]> {
    const profile = await this.metadata(database, scopeKind, scopeId);
    if (profile === null) {
      return [];
    }
    const rows = await database
      .selectFrom("variables as variable")
      .leftJoin(
        "variable_secrets as secret",
        "secret.variable_id",
        "variable.id",
      )
      .select([
        "variable.id",
        "variable.name",
        "variable.kind",
        "variable.value_text",
        "variable.alias_target",
        "secret.payload",
        "secret.version as secret_version",
      ])
      .where("variable.profile_id", "=", idToBytes(profile.profileId))
      .orderBy("variable.position")
      .execute();
    return rows.map((row) => ({
      variableId: bytesToId(row.id),
      name: row.name,
      kind: row.kind,
      value: row.kind === "secret" ? row.payload : row.value_text,
      aliasTarget: row.alias_target,
      secretVersion: row.secret_version,
    }));
  }

  /** Deletes one profile and all of its variable and secret rows. */
  async delete(
    transaction: Transaction<DatabaseSchema>,
    scopeKind: VariableScopeKind,
    scopeId: EntityId,
  ): Promise<void> {
    await transaction
      .deleteFrom("variable_profiles")
      .where("scope_kind", "=", scopeKind)
      .where("scope_id", "=", idToBytes(scopeId))
      .execute();
  }

  /** Returns the configured database for read-only service composition. */
  get database(): Kysely<DatabaseSchema> {
    return this.#database;
  }

  /** Replaces ordered rows while preserving omitted existing secret payloads. */
  async #replaceRows(
    transaction: Transaction<DatabaseSchema>,
    profileId: EntityId,
    writes: readonly VariableWrite[],
    allowUnconfiguredSecrets: boolean,
  ): Promise<SecretMutation[]> {
    const existingRows = await transaction
      .selectFrom("variables as variable")
      .leftJoin(
        "variable_secrets as secret",
        "secret.variable_id",
        "variable.id",
      )
      .select([
        "variable.id",
        "variable.kind",
        "secret.version",
        "secret.payload",
      ])
      .where("variable.profile_id", "=", idToBytes(profileId))
      .execute();
    const existing = new Map(
      existingRows.map((row) => [bytesToId(row.id), row] as const),
    );
    const usedIds = new Set<EntityId>();
    const usedNames = new Set<string>();
    const prepared = writes.map((write, position) => {
      validateVariableName(write.name);
      if (usedNames.has(write.name)) {
        throw new Error(`Variable name ${write.name} is duplicated`);
      }
      usedNames.add(write.name);
      const variableId = write.variableId ?? createEntityId();
      if (usedIds.has(variableId)) {
        throw new Error("A variable identifier was submitted more than once");
      }
      usedIds.add(variableId);
      const previous = existing.get(variableId);
      if (write.variableId !== undefined && previous === undefined) {
        throw new ResourceNotFoundError("Variable not found");
      }
      if (previous !== undefined && previous.kind !== write.kind) {
        throw new VariableProfileConflictError(
          "An existing variable's kind cannot be changed",
        );
      }
      if (write.kind === "alias") {
        validateVariableName(write.target);
      }
      const description = validateFieldDescription(write.description);
      if (write.kind === "secret") {
        const replacing = write.value !== undefined;
        if (replacing && write.clearValue === true) {
          throw new Error("A secret cannot be replaced and cleared together");
        }
        if (
          previous?.kind !== "secret" &&
          !replacing &&
          !allowUnconfiguredSecrets
        ) {
          throw new Error("A new secret requires a value");
        }
      }
      return { write, variableId, position, previous, description };
    });
    const mutations: SecretMutation[] = [];
    for (const [variableId, previous] of existing) {
      if (previous.kind === "secret" && !usedIds.has(variableId)) {
        mutations.push({
          type: "deleted",
          variableId,
          version: previous.version ?? 1,
        });
      }
    }
    await transaction
      .deleteFrom("variables")
      .where("profile_id", "=", idToBytes(profileId))
      .execute();
    for (const item of prepared) {
      const { write } = item;
      await transaction
        .insertInto("variables")
        .values({
          id: idToBytes(item.variableId),
          profile_id: idToBytes(profileId),
          position: item.position,
          name: write.name,
          description_text: item.description,
          kind: write.kind,
          value_text: write.kind === "value" ? write.value : null,
          alias_target: write.kind === "alias" ? write.target : null,
        })
        .execute();
      if (write.kind !== "secret") {
        continue;
      }
      const changed = write.value !== undefined || write.clearValue === true;
      const version =
        item.previous?.kind === "secret"
          ? (item.previous.version ?? 0) + (changed ? 1 : 0)
          : 1;
      const payload =
        write.value !== undefined
          ? write.value
          : write.clearValue === true
            ? null
            : (item.previous?.payload ?? null);
      await transaction
        .insertInto("variable_secrets")
        .values({
          variable_id: idToBytes(item.variableId),
          version,
          storage_format: "plaintext-v1",
          payload,
        })
        .execute();
      if (item.previous?.kind !== "secret") {
        mutations.push({
          type: "created",
          variableId: item.variableId,
          version,
        });
      } else if (write.clearValue === true) {
        mutations.push({
          type: "cleared",
          variableId: item.variableId,
          version,
        });
      } else if (write.value !== undefined) {
        mutations.push({
          type: "replaced",
          variableId: item.variableId,
          version,
        });
      }
    }
    return mutations;
  }
}

/** Validates one case-sensitive persisted variable or alias name. */
export function validateVariableName(name: string): void {
  if (!VARIABLE_NAME.test(name)) {
    throw new Error("Variable names must match [A-Za-z_][A-Za-z0-9_.-]*");
  }
}
