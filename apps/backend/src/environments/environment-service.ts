import type { Kysely, Transaction } from "kysely";

import type { AuditService } from "../audit/audit-service.js";
import {
  bytesToId,
  createEntityId,
  idToBytes,
  type EntityId,
} from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";
import {
  type ResolvedVariable,
  type SecretMutation,
  VariableProfileConflictError,
  VariableProfileStore,
  type VariableView,
  type VariableWrite,
  validateVariableName,
} from "../variables/variable-profile-store.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";
import {
  normalizeName,
  ResourceNotFoundError,
} from "../workspaces/workspace-service.js";
import { VariableResolver } from "./variable-resolver.js";

export type EnvironmentVariableWrite = VariableWrite;
export type EnvironmentVariableView = VariableView;

export interface EnvironmentView {
  readonly environmentId: EntityId;
  readonly workspaceId: EntityId;
  readonly name: string;
  readonly revision: number;
  readonly variables: readonly EnvironmentVariableView[];
}

export interface EnvironmentSummary {
  readonly environmentId: EntityId;
  readonly name: string;
  readonly revision: number;
}

export interface EnvironmentListView {
  readonly environments: readonly EnvironmentSummary[];
  readonly selectedEnvironmentId: EntityId | null;
}

export type ResolvedEnvironmentVariable = ResolvedVariable;

export interface SelectedEnvironmentProfile {
  readonly environmentId: EntityId;
  readonly name: string;
  readonly revision: number;
  readonly variables: readonly ResolvedEnvironmentVariable[];
}

/** Identifies the effective persisted scope supplying a previewed variable. */
export interface VariablePreviewSource {
  readonly scope: "environment";
  readonly scopeId: EntityId;
  readonly scopeName: string;
  readonly revision: number;
}

/** Describes one editor-visible resolution without exposing secret plaintext. */
export interface VariablePreview {
  readonly name: string;
  readonly status: "resolved" | "missing" | "unset" | "error";
  readonly declaredKind: "value" | "secret" | "alias" | "unset" | null;
  readonly effectiveKind: "value" | "secret" | null;
  readonly aliasTarget: string | null;
  readonly value: string | null;
  readonly secretVersion: number | null;
  readonly diagnostic: string | null;
  readonly source: VariablePreviewSource | null;
}

/** Returns previews in the same order as the requested unique variable names. */
export interface VariablePreviewResult {
  readonly previews: readonly VariablePreview[];
}

/** Raised when an environment profile changed before a submitted mutation. */
export class EnvironmentConflictError extends Error {}

/** Owns workspace environments, redacted variables, and session selections. */
export class EnvironmentService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #workspaces: WorkspaceService;
  readonly #audit: AuditService;
  readonly #variables: VariableProfileStore;

  constructor(
    database: Kysely<DatabaseSchema>,
    workspaces: WorkspaceService,
    audit: AuditService,
  ) {
    this.#database = database;
    this.#workspaces = workspaces;
    this.#audit = audit;
    this.#variables = new VariableProfileStore(database);
  }

  /** Lists one workspace's environments and the current session's selection. */
  async list(
    userId: EntityId,
    sessionId: EntityId,
    workspaceId: EntityId,
  ): Promise<EnvironmentListView> {
    await this.#workspaces.requireCanRead(this.#database, userId, workspaceId);
    const [rows, selection] = await Promise.all([
      this.#database
        .selectFrom("environments")
        .select(["id", "name", "revision"])
        .where("workspace_id", "=", idToBytes(workspaceId))
        .orderBy("created_at")
        .orderBy("id")
        .execute(),
      this.#database
        .selectFrom("session_workspace_environments")
        .select("selected_environment_id")
        .where("session_id", "=", idToBytes(sessionId))
        .where("workspace_id", "=", idToBytes(workspaceId))
        .executeTakeFirst(),
    ]);
    return {
      environments: rows.map((row) => ({
        environmentId: bytesToId(row.id),
        name: row.name,
        revision: row.revision,
      })),
      selectedEnvironmentId:
        selection === undefined
          ? null
          : bytesToId(selection.selected_environment_id),
    };
  }

  /** Creates an environment and its initial ordered variable profile. */
  async create(
    userId: EntityId,
    workspaceId: EntityId,
    name: string,
    variables: readonly EnvironmentVariableWrite[],
  ): Promise<EnvironmentView> {
    return this.#database.transaction().execute(async (transaction) => {
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      const environmentId = createEntityId();
      const displayName = normalizeName(name).normalize("NFC");
      const now = Date.now();
      await transaction
        .insertInto("environments")
        .values({
          id: idToBytes(environmentId),
          workspace_id: idToBytes(workspaceId),
          name: displayName,
          name_key: environmentNameKey(displayName),
          revision: 0,
          created_by: idToBytes(userId),
          created_at: now,
          updated_by: idToBytes(userId),
          updated_at: now,
        })
        .execute();
      const secretMutations = await this.#variables.create(
        transaction,
        workspaceId,
        "environment",
        environmentId,
        0,
        userId,
        variables,
      );
      await this.#audit.record(transaction, {
        type: "environment.created",
        actorUserId: userId,
        workspaceId,
        data: { environmentId, name: displayName },
      });
      await this.#recordSecretMutations(
        transaction,
        userId,
        workspaceId,
        environmentId,
        secretMutations,
      );
      return this.#view(transaction, environmentId);
    });
  }

  /** Loads one authorized environment without exposing secret plaintext. */
  async get(
    userId: EntityId,
    environmentId: EntityId,
  ): Promise<EnvironmentView> {
    const row = await this.#row(this.#database, environmentId);
    await this.#workspaces.requireCanRead(
      this.#database,
      userId,
      bytesToId(row.workspace_id),
    );
    return this.#view(this.#database, environmentId);
  }

  /** Replaces one environment profile under optimistic concurrency. */
  async update(
    userId: EntityId,
    environmentId: EntityId,
    expectedRevision: number,
    name: string,
    variables: readonly EnvironmentVariableWrite[],
  ): Promise<EnvironmentView> {
    return this.#database.transaction().execute(async (transaction) => {
      const row = await this.#row(transaction, environmentId);
      const workspaceId = bytesToId(row.workspace_id);
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      if (row.revision !== expectedRevision) {
        throw new EnvironmentConflictError("The environment profile changed");
      }
      const displayName = normalizeName(name).normalize("NFC");
      let secretMutations: readonly SecretMutation[];
      try {
        ({ mutations: secretMutations } = await this.#variables.replace(
          transaction,
          "environment",
          environmentId,
          expectedRevision,
          userId,
          variables,
        ));
      } catch (cause) {
        if (cause instanceof VariableProfileConflictError) {
          throw new EnvironmentConflictError(cause.message);
        }
        throw cause;
      }
      await transaction
        .updateTable("environments")
        .set({
          name: displayName,
          name_key: environmentNameKey(displayName),
          revision: expectedRevision + 1,
          updated_by: idToBytes(userId),
          updated_at: Date.now(),
        })
        .where("id", "=", idToBytes(environmentId))
        .execute();
      await this.#audit.record(transaction, {
        type: "environment.updated",
        actorUserId: userId,
        workspaceId,
        data: { environmentId, revision: expectedRevision + 1 },
      });
      await this.#recordSecretMutations(
        transaction,
        userId,
        workspaceId,
        environmentId,
        secretMutations,
      );
      return this.#view(transaction, environmentId);
    });
  }

  /** Deletes one current environment and atomically clears its selections. */
  async delete(
    userId: EntityId,
    environmentId: EntityId,
    expectedRevision: number,
  ): Promise<{ readonly deleted: true }> {
    return this.#database.transaction().execute(async (transaction) => {
      const row = await this.#row(transaction, environmentId);
      const workspaceId = bytesToId(row.workspace_id);
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      if (row.revision !== expectedRevision) {
        throw new EnvironmentConflictError("The environment profile changed");
      }
      const deletedSecrets = await transaction
        .selectFrom("variable_profiles as profile")
        .innerJoin("variables as variable", "variable.profile_id", "profile.id")
        .innerJoin(
          "variable_secrets as secret",
          "secret.variable_id",
          "variable.id",
        )
        .select(["variable.id", "secret.version"])
        .where("profile.scope_kind", "=", "environment")
        .where("profile.scope_id", "=", idToBytes(environmentId))
        .execute();
      await this.#variables.delete(transaction, "environment", environmentId);
      await transaction
        .deleteFrom("environments")
        .where("id", "=", idToBytes(environmentId))
        .execute();
      await this.#audit.record(transaction, {
        type: "environment.deleted",
        actorUserId: userId,
        workspaceId,
        data: { environmentId },
      });
      await this.#recordSecretMutations(
        transaction,
        userId,
        workspaceId,
        environmentId,
        deletedSecrets.map((secret) => ({
          type: "deleted",
          variableId: bytesToId(secret.id),
          version: secret.version,
        })),
      );
      return { deleted: true };
    });
  }

  /** Sets or clears the last-write-wins environment for a session/workspace. */
  async select(
    userId: EntityId,
    sessionId: EntityId,
    workspaceId: EntityId,
    environmentId: EntityId | null,
  ): Promise<{ readonly selectedEnvironmentId: EntityId | null }> {
    await this.#database.transaction().execute(async (transaction) => {
      await this.#workspaces.requireCanEdit(transaction, userId, workspaceId);
      const session = await transaction
        .selectFrom("sessions")
        .select("id")
        .where("id", "=", idToBytes(sessionId))
        .where("user_id", "=", idToBytes(userId))
        .where("status", "=", "active")
        .executeTakeFirst();
      if (session === undefined) {
        throw new ResourceNotFoundError("Session not found");
      }
      if (environmentId === null) {
        await transaction
          .deleteFrom("session_workspace_environments")
          .where("session_id", "=", idToBytes(sessionId))
          .where("workspace_id", "=", idToBytes(workspaceId))
          .execute();
        return;
      }
      const environment = await this.#row(transaction, environmentId);
      if (bytesToId(environment.workspace_id) !== workspaceId) {
        throw new ResourceNotFoundError("Environment not found");
      }
      await transaction
        .insertInto("session_workspace_environments")
        .values({
          session_id: idToBytes(sessionId),
          workspace_id: idToBytes(workspaceId),
          selected_environment_id: idToBytes(environmentId),
          updated_at: Date.now(),
        })
        .onConflict((conflict) =>
          conflict.columns(["session_id", "workspace_id"]).doUpdateSet({
            selected_environment_id: idToBytes(environmentId),
            updated_at: Date.now(),
          }),
        )
        .execute();
    });
    return { selectedEnvironmentId: environmentId };
  }

  /** Resolves requested names for editor hints without returning secret values. */
  async previewVariables(
    userId: EntityId,
    sessionId: EntityId,
    workspaceId: EntityId,
    names: readonly string[],
  ): Promise<VariablePreviewResult> {
    await this.#workspaces.requireCanRead(this.#database, userId, workspaceId);
    const profile = await this.selectedProfile(
      this.#database,
      sessionId,
      workspaceId,
    );
    if (profile === null) {
      return {
        previews: names.map((name) => ({
          name,
          status: "missing",
          declaredKind: null,
          effectiveKind: null,
          aliasTarget: null,
          value: null,
          secretVersion: null,
          diagnostic: "No environment is selected",
          source: null,
        })),
      };
    }
    const variables = new Map(
      profile.variables.map((variable) => [variable.name, variable] as const),
    );
    const resolver = new VariableResolver(profile);
    const source: VariablePreviewSource = {
      scope: "environment",
      scopeId: profile.environmentId,
      scopeName: profile.name,
      revision: profile.revision,
    };
    return {
      previews: names.map((name) => {
        validateVariableName(name);
        const variable = variables.get(name);
        if (variable === undefined) {
          return {
            name,
            status: "missing",
            declaredKind: null,
            effectiveKind: null,
            aliasTarget: null,
            value: null,
            secretVersion: null,
            diagnostic: `Variable ${name} is missing`,
            source: null,
          };
        }
        const common = {
          name,
          declaredKind: variable.kind,
          aliasTarget: variable.kind === "alias" ? variable.aliasTarget : null,
          source,
        };
        if (variable.kind === "unset") {
          return {
            ...common,
            status: "unset",
            effectiveKind: null,
            value: null,
            secretVersion: null,
            diagnostic: `Variable ${name} is unset`,
          };
        }
        try {
          const resolved = resolver.resolve(name);
          return {
            ...common,
            status: "resolved",
            effectiveKind: resolved.effectiveKind,
            value: resolved.secret ? null : resolved.value,
            secretVersion:
              resolved.secretReferences[0]?.version ??
              (variable.kind === "secret" ? variable.secretVersion : null),
            diagnostic: null,
          };
        } catch (cause) {
          return {
            ...common,
            status: "error",
            effectiveKind: variable.kind === "secret" ? "secret" : null,
            value: null,
            secretVersion:
              variable.kind === "secret" ? variable.secretVersion : null,
            diagnostic:
              cause instanceof Error
                ? cause.message
                : `Variable ${name} could not be resolved`,
          };
        }
      }),
    };
  }

  /** Loads the selected environment including secrets for composition only. */
  async selectedProfile(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    sessionId: EntityId,
    workspaceId: EntityId,
  ): Promise<SelectedEnvironmentProfile | null> {
    const selected = await database
      .selectFrom("session_workspace_environments as selection")
      .innerJoin(
        "environments as environment",
        "environment.id",
        "selection.selected_environment_id",
      )
      .select(["environment.id", "environment.name", "environment.revision"])
      .where("selection.session_id", "=", idToBytes(sessionId))
      .where("selection.workspace_id", "=", idToBytes(workspaceId))
      .where("environment.workspace_id", "=", idToBytes(workspaceId))
      .executeTakeFirst();
    if (selected === undefined) {
      return null;
    }
    const environmentId = bytesToId(selected.id);
    const variables = await this.#variables.resolvedVariables(
      database,
      "environment",
      environmentId,
    );
    return {
      environmentId,
      name: selected.name,
      revision: selected.revision,
      variables,
    };
  }

  /** Records allowlisted secret lifecycle metadata without secret plaintext. */
  async #recordSecretMutations(
    transaction: Transaction<DatabaseSchema>,
    userId: EntityId,
    workspaceId: EntityId,
    environmentId: EntityId,
    mutations: readonly SecretMutation[],
  ): Promise<void> {
    for (const mutation of mutations) {
      await this.#audit.record(transaction, {
        type: `secret_variable.${mutation.type}`,
        actorUserId: userId,
        workspaceId,
        data: {
          environmentId,
          variableId: mutation.variableId,
          secretVersion: mutation.version,
        },
      });
    }
  }

  /** Loads environment ownership and revision or raises concealed not-found. */
  async #row(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    environmentId: EntityId,
  ) {
    const row = await database
      .selectFrom("environments")
      .selectAll()
      .where("id", "=", idToBytes(environmentId))
      .executeTakeFirst();
    if (row === undefined) {
      throw new ResourceNotFoundError("Environment not found");
    }
    return row;
  }

  /** Builds the public environment view with secret values redacted. */
  async #view(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    environmentId: EntityId,
  ): Promise<EnvironmentView> {
    const environment = await this.#row(database, environmentId);
    return {
      environmentId,
      workspaceId: bytesToId(environment.workspace_id),
      name: environment.name,
      revision: environment.revision,
      variables: await this.#variables.redactedVariables(
        database,
        "environment",
        environmentId,
      ),
    };
  }
}

/** Produces the database-independent case-insensitive environment name key. */
export function environmentNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
