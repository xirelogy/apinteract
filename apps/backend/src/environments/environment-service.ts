import type { Kysely, Transaction } from "kysely";

import type { AuditService } from "../audit/audit-service.js";
import {
  bytesToId,
  createEntityId,
  idToBytes,
  type EntityId,
} from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";
import {
  normalizeName,
  ResourceNotFoundError,
} from "../workspaces/workspace-service.js";
import { VariableResolver } from "./variable-resolver.js";

export type EnvironmentVariableWrite =
  | {
      readonly variableId?: EntityId;
      readonly name: string;
      readonly kind: "value";
      readonly value: string;
    }
  | {
      readonly variableId?: EntityId;
      readonly name: string;
      readonly kind: "alias";
      readonly target: string;
    }
  | {
      readonly variableId?: EntityId;
      readonly name: string;
      readonly kind: "unset";
    }
  | {
      readonly variableId?: EntityId;
      readonly name: string;
      readonly kind: "secret";
      readonly value?: string;
      readonly clearValue?: boolean;
    };

export type EnvironmentVariableView =
  | {
      readonly variableId: EntityId;
      readonly name: string;
      readonly kind: "value";
      readonly value: string;
    }
  | {
      readonly variableId: EntityId;
      readonly name: string;
      readonly kind: "alias";
      readonly target: string;
    }
  | {
      readonly variableId: EntityId;
      readonly name: string;
      readonly kind: "unset";
    }
  | {
      readonly variableId: EntityId;
      readonly name: string;
      readonly kind: "secret";
      readonly hasValue: boolean;
      readonly secretVersion: number;
    };

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

export interface ResolvedEnvironmentVariable {
  readonly variableId: EntityId;
  readonly name: string;
  readonly kind: "value" | "secret" | "alias" | "unset";
  readonly value: string | null;
  readonly aliasTarget: string | null;
  readonly secretVersion: number | null;
}

export interface SelectedEnvironmentProfile {
  readonly environmentId: EntityId;
  readonly name: string;
  readonly revision: number;
  readonly variables: readonly ResolvedEnvironmentVariable[];
}

/** Identifies the effective persisted scope supplying a previewed variable. */
export interface VariablePreviewSource {
  readonly scope: "environment";
  readonly environmentId: EntityId;
  readonly environmentName: string;
  readonly environmentRevision: number;
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

interface SecretMutation {
  readonly type: "created" | "replaced" | "cleared" | "deleted";
  readonly variableId: EntityId;
  readonly version: number;
}

/** Raised when an environment profile changed before a submitted mutation. */
export class EnvironmentConflictError extends Error {}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;

/** Owns workspace environments, redacted variables, and session selections. */
export class EnvironmentService {
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
      const secretMutations = await this.#replaceVariables(
        transaction,
        environmentId,
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
      const secretMutations = await this.#replaceVariables(
        transaction,
        environmentId,
        variables,
      );
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
        .selectFrom("environment_variables as variable")
        .innerJoin(
          "environment_variable_secrets as secret",
          "secret.variable_id",
          "variable.id",
        )
        .select(["variable.id", "secret.version"])
        .where("variable.environment_id", "=", idToBytes(environmentId))
        .execute();
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
      environmentId: profile.environmentId,
      environmentName: profile.name,
      environmentRevision: profile.revision,
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
    const variables = await database
      .selectFrom("environment_variables as variable")
      .leftJoin(
        "environment_variable_secrets as secret",
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
      .where("variable.environment_id", "=", selected.id)
      .orderBy("variable.position")
      .execute();
    return {
      environmentId: bytesToId(selected.id),
      name: selected.name,
      revision: selected.revision,
      variables: variables.map((variable) => ({
        variableId: bytesToId(variable.id),
        name: variable.name,
        kind: variable.kind,
        value:
          variable.kind === "secret" ? variable.payload : variable.value_text,
        aliasTarget: variable.alias_target,
        secretVersion: variable.secret_version,
      })),
    };
  }

  /** Replaces ordered variables while preserving omitted existing secrets. */
  async #replaceVariables(
    transaction: Transaction<DatabaseSchema>,
    environmentId: EntityId,
    writes: readonly EnvironmentVariableWrite[],
  ): Promise<SecretMutation[]> {
    const existingRows = await transaction
      .selectFrom("environment_variables as variable")
      .leftJoin(
        "environment_variable_secrets as secret",
        "secret.variable_id",
        "variable.id",
      )
      .select([
        "variable.id",
        "variable.kind",
        "secret.version",
        "secret.payload",
      ])
      .where("variable.environment_id", "=", idToBytes(environmentId))
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
        throw new ResourceNotFoundError("Environment variable not found");
      }
      if (previous !== undefined && previous.kind !== write.kind) {
        throw new EnvironmentConflictError(
          "An existing environment variable's kind cannot be changed",
        );
      }
      if (write.kind === "alias") {
        validateVariableName(write.target);
      }
      if (write.kind === "secret") {
        const replacing = write.value !== undefined;
        if (replacing && write.clearValue === true) {
          throw new Error("A secret cannot be replaced and cleared together");
        }
        if (previous?.kind !== "secret" && !replacing) {
          throw new Error("A new secret requires a value");
        }
      }
      return { write, variableId, position, previous };
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
      .deleteFrom("environment_variables")
      .where("environment_id", "=", idToBytes(environmentId))
      .execute();
    for (const item of prepared) {
      const { write } = item;
      await transaction
        .insertInto("environment_variables")
        .values({
          id: idToBytes(item.variableId),
          environment_id: idToBytes(environmentId),
          position: item.position,
          name: write.name,
          kind: write.kind,
          value_text: write.kind === "value" ? write.value : null,
          alias_target: write.kind === "alias" ? write.target : null,
        })
        .execute();
      if (write.kind === "secret") {
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
          .insertInto("environment_variable_secrets")
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
    }
    return mutations;
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
    const variables = await database
      .selectFrom("environment_variables as variable")
      .leftJoin(
        "environment_variable_secrets as secret",
        "secret.variable_id",
        "variable.id",
      )
      .select([
        "variable.id",
        "variable.name",
        "variable.kind",
        "variable.value_text",
        "variable.alias_target",
        "secret.version",
        "secret.payload",
      ])
      .where("variable.environment_id", "=", idToBytes(environmentId))
      .orderBy("variable.position")
      .execute();
    return {
      environmentId,
      workspaceId: bytesToId(environment.workspace_id),
      name: environment.name,
      revision: environment.revision,
      variables: variables.map((variable): EnvironmentVariableView => {
        const common = {
          variableId: bytesToId(variable.id),
          name: variable.name,
        };
        switch (variable.kind) {
          case "value":
            return {
              ...common,
              kind: "value",
              value: variable.value_text ?? "",
            };
          case "alias":
            return {
              ...common,
              kind: "alias",
              target: variable.alias_target ?? "",
            };
          case "unset":
            return { ...common, kind: "unset" };
          case "secret":
            return {
              ...common,
              kind: "secret",
              hasValue: variable.payload !== null,
              secretVersion: variable.version ?? 1,
            };
        }
      }),
    };
  }
}

/** Produces the database-independent case-insensitive environment name key. */
export function environmentNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** Validates one case-sensitive variable or alias name. */
function validateVariableName(name: string): void {
  if (!VARIABLE_NAME.test(name)) {
    throw new Error("Variable names must match [A-Za-z_][A-Za-z0-9_.-]*");
  }
}
