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
  readonly includedEnvironments: readonly EnvironmentSummary[];
  readonly variables: readonly EnvironmentVariableView[];
  readonly inheritedVariables: readonly InheritedEnvironmentVariableView[];
}

/** Describes one lower-precedence variable inherited by an environment. */
export interface InheritedEnvironmentVariableView {
  readonly variable: EnvironmentVariableView;
  readonly source: {
    readonly scope: "workspace" | "environment";
    readonly scopeId: EntityId;
    readonly scopeName: string;
    readonly revision: number;
  };
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
  readonly sources: ReadonlyMap<string, SelectedEnvironmentProfileMetadata>;
  readonly evidence: readonly SelectedEnvironmentProfileMetadata[];
}

/** Provides a selected composed profile without loading secret plaintext. */
export interface SelectedRedactedEnvironmentProfile {
  readonly environmentId: EntityId;
  readonly name: string;
  readonly revision: number;
  readonly variables: readonly EnvironmentVariableView[];
  readonly sources: ReadonlyMap<string, SelectedEnvironmentProfileMetadata>;
  readonly evidence: readonly SelectedEnvironmentProfileMetadata[];
}

/** Identifies a selected environment without loading secret-bearing values. */
export interface SelectedEnvironmentProfileMetadata {
  readonly environmentId: EntityId;
  readonly name: string;
  readonly revision: number;
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

/** Raised when a proposed inclusion list would make composition cyclic. */
export class EnvironmentCompositionCycleError extends Error {}

/** Raised when an inclusion list is malformed or references another workspace. */
export class EnvironmentCompositionInvalidError extends Error {}

/** Raised when an environment cannot be deleted while others include it. */
export class EnvironmentInUseError extends Error {}

interface NamedEnvironmentVariable {
  readonly name: string;
}

interface ComposedEnvironmentProfile<T extends NamedEnvironmentVariable> {
  readonly variables: readonly T[];
  readonly sources: ReadonlyMap<string, SelectedEnvironmentProfileMetadata>;
  readonly evidence: readonly SelectedEnvironmentProfileMetadata[];
}

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
    includedEnvironmentIds: readonly EntityId[] = [],
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
      await this.#replaceIncludes(
        transaction,
        workspaceId,
        environmentId,
        includedEnvironmentIds,
      );
      await this.#audit.record(transaction, {
        type: "environment.created",
        actorUserId: userId,
        workspaceId,
        data: { environmentId, name: displayName, includedEnvironmentIds },
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
    includedEnvironmentIds?: readonly EntityId[],
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
      if (includedEnvironmentIds !== undefined) {
        await this.#replaceIncludes(
          transaction,
          workspaceId,
          environmentId,
          includedEnvironmentIds,
        );
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
        data: {
          environmentId,
          revision: expectedRevision + 1,
          ...(includedEnvironmentIds === undefined
            ? {}
            : { includedEnvironmentIds }),
        },
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
      const dependents = await transaction
        .selectFrom("environment_includes as include")
        .innerJoin(
          "environments as environment",
          "environment.id",
          "include.environment_id",
        )
        .select("environment.name")
        .where("include.included_environment_id", "=", idToBytes(environmentId))
        .orderBy("include.environment_id")
        .execute();
      if (dependents.length > 0) {
        throw new EnvironmentInUseError(
          `The environment is included by ${dependents.map((dependent) => dependent.name).join(", ")}`,
        );
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
          source:
            profile.sources.get(name) === undefined
              ? null
              : environmentPreviewSource(profile.sources.get(name)!),
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
    const selected = await this.selectedProfileMetadata(
      database,
      sessionId,
      workspaceId,
    );
    if (selected === null) return null;
    const composition = await this.#composeEnvironment(
      database,
      workspaceId,
      selected.environmentId,
      (environmentId) =>
        this.#variables.resolvedVariables(
          database,
          "environment",
          environmentId,
        ),
    );
    return { ...selected, ...composition };
  }

  /** Loads a selected composed profile with every secret value redacted. */
  async selectedRedactedProfile(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    sessionId: EntityId,
    workspaceId: EntityId,
  ): Promise<SelectedRedactedEnvironmentProfile | null> {
    const selected = await this.selectedProfileMetadata(
      database,
      sessionId,
      workspaceId,
    );
    if (selected === null) return null;
    const composition = await this.#composeEnvironment(
      database,
      workspaceId,
      selected.environmentId,
      (environmentId) =>
        this.#variables.redactedVariables(
          database,
          "environment",
          environmentId,
        ),
    );
    return { ...selected, ...composition };
  }

  /** Loads selected-environment identity without reading secret plaintext. */
  async selectedProfileMetadata(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    sessionId: EntityId,
    workspaceId: EntityId,
  ): Promise<SelectedEnvironmentProfileMetadata | null> {
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
    return {
      environmentId: bytesToId(selected.id),
      name: selected.name,
      revision: selected.revision,
    };
  }

  /** Replaces and validates one environment's complete ordered include list. */
  async #replaceIncludes(
    transaction: Transaction<DatabaseSchema>,
    workspaceId: EntityId,
    environmentId: EntityId,
    includedEnvironmentIds: readonly EntityId[],
  ): Promise<void> {
    if (
      new Set(includedEnvironmentIds).size !== includedEnvironmentIds.length
    ) {
      throw new EnvironmentCompositionInvalidError(
        "An environment can be included only once",
      );
    }
    const environmentRows = await transaction
      .selectFrom("environments")
      .select(["id", "name"])
      .where("workspace_id", "=", idToBytes(workspaceId))
      .execute();
    const names = new Map(
      environmentRows.map((row) => [bytesToId(row.id), row.name] as const),
    );
    if (
      !names.has(environmentId) ||
      includedEnvironmentIds.some((includedId) => !names.has(includedId))
    ) {
      throw new ResourceNotFoundError("Included environment not found");
    }
    const edgeRows = await transaction
      .selectFrom("environment_includes")
      .select(["environment_id", "included_environment_id"])
      .where("workspace_id", "=", idToBytes(workspaceId))
      .orderBy("environment_id")
      .orderBy("position")
      .execute();
    const edges = new Map<EntityId, EntityId[]>();
    for (const row of edgeRows) {
      const includingId = bytesToId(row.environment_id);
      const includedId = bytesToId(row.included_environment_id);
      const includes = edges.get(includingId) ?? [];
      includes.push(includedId);
      edges.set(includingId, includes);
    }
    edges.set(environmentId, [...includedEnvironmentIds]);
    const cycle = findEnvironmentCycle(environmentId, edges);
    if (cycle !== null) {
      throw new EnvironmentCompositionCycleError(
        `Environment composition would be cyclic: ${cycle
          .map((cycleId) => names.get(cycleId) ?? cycleId)
          .join(" → ")}`,
      );
    }
    await transaction
      .deleteFrom("environment_includes")
      .where("environment_id", "=", idToBytes(environmentId))
      .execute();
    if (includedEnvironmentIds.length > 0) {
      await transaction
        .insertInto("environment_includes")
        .values(
          includedEnvironmentIds.map((includedEnvironmentId, position) => ({
            workspace_id: idToBytes(workspaceId),
            environment_id: idToBytes(environmentId),
            included_environment_id: idToBytes(includedEnvironmentId),
            position,
          })),
        )
        .execute();
    }
  }

  /** Composes one environment graph with deterministic last-writer precedence. */
  async #composeEnvironment<T extends NamedEnvironmentVariable>(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    workspaceId: EntityId,
    environmentId: EntityId,
    loadVariables: (environmentId: EntityId) => Promise<readonly T[]>,
    includeRootVariables = true,
  ): Promise<ComposedEnvironmentProfile<T>> {
    const [environmentRows, edgeRows] = await Promise.all([
      database
        .selectFrom("environments")
        .select(["id", "name", "revision"])
        .where("workspace_id", "=", idToBytes(workspaceId))
        .execute(),
      database
        .selectFrom("environment_includes")
        .select(["environment_id", "included_environment_id"])
        .where("workspace_id", "=", idToBytes(workspaceId))
        .orderBy("environment_id")
        .orderBy("position")
        .execute(),
    ]);
    const metadata = new Map<EntityId, SelectedEnvironmentProfileMetadata>(
      environmentRows.map((row) => {
        const id = bytesToId(row.id);
        return [
          id,
          { environmentId: id, name: row.name, revision: row.revision },
        ];
      }),
    );
    if (!metadata.has(environmentId)) {
      throw new ResourceNotFoundError("Environment not found");
    }
    const edges = new Map<EntityId, EntityId[]>();
    for (const row of edgeRows) {
      const includingId = bytesToId(row.environment_id);
      const includedId = bytesToId(row.included_environment_id);
      const includes = edges.get(includingId) ?? [];
      includes.push(includedId);
      edges.set(includingId, includes);
    }
    const cache = new Map<EntityId, ComposedEnvironmentProfile<T>>();
    const stack: EntityId[] = [];

    /** Resolves one node once while guarding persisted graph integrity. */
    const resolve = async (
      currentId: EntityId,
    ): Promise<ComposedEnvironmentProfile<T>> => {
      const cached = cache.get(currentId);
      if (cached !== undefined) return cached;
      const cycleStart = stack.indexOf(currentId);
      if (cycleStart >= 0) {
        const cycle = [...stack.slice(cycleStart), currentId];
        throw new EnvironmentCompositionCycleError(
          `Stored environment composition is cyclic: ${cycle
            .map((cycleId) => metadata.get(cycleId)?.name ?? cycleId)
            .join(" → ")}`,
        );
      }
      const current = metadata.get(currentId);
      if (current === undefined) {
        throw new ResourceNotFoundError("Included environment not found");
      }
      stack.push(currentId);
      try {
        const variables = new Map<string, T>();
        const sources = new Map<string, SelectedEnvironmentProfileMetadata>();
        const evidence: SelectedEnvironmentProfileMetadata[] = [];
        for (const includedId of edges.get(currentId) ?? []) {
          mergeComposedProfile(
            variables,
            sources,
            evidence,
            await resolve(includedId),
          );
        }
        for (const variable of await loadVariables(currentId)) {
          variables.set(variable.name, variable);
          sources.set(variable.name, current);
        }
        mergeEnvironmentEvidence(evidence, [current]);
        const result = {
          variables: [...variables.values()],
          sources,
          evidence,
        } satisfies ComposedEnvironmentProfile<T>;
        cache.set(currentId, result);
        return result;
      } finally {
        stack.pop();
      }
    };

    if (includeRootVariables) return resolve(environmentId);
    const variables = new Map<string, T>();
    const sources = new Map<string, SelectedEnvironmentProfileMetadata>();
    const evidence: SelectedEnvironmentProfileMetadata[] = [];
    for (const includedId of edges.get(environmentId) ?? []) {
      mergeComposedProfile(
        variables,
        sources,
        evidence,
        await resolve(includedId),
      );
    }
    return { variables: [...variables.values()], sources, evidence };
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
    const workspaceId = bytesToId(environment.workspace_id);
    return {
      environmentId,
      workspaceId,
      name: environment.name,
      revision: environment.revision,
      includedEnvironments: await this.#directIncludes(database, environmentId),
      variables: await this.#variables.redactedVariables(
        database,
        "environment",
        environmentId,
      ),
      inheritedVariables: await this.#inheritedVariables(
        database,
        workspaceId,
        environmentId,
      ),
    };
  }

  /** Returns effective redacted workspace and included-environment variables. */
  async #inheritedVariables(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    workspaceId: EntityId,
    environmentId: EntityId,
  ): Promise<readonly InheritedEnvironmentVariableView[]> {
    const metadata = await this.#variables.metadata(
      database,
      "workspace",
      workspaceId,
    );
    const workspace = await database
      .selectFrom("workspaces")
      .select("name")
      .where("id", "=", idToBytes(workspaceId))
      .executeTakeFirstOrThrow();
    const inherited = new Map<string, InheritedEnvironmentVariableView>();
    if (metadata !== null) {
      const source = {
        scope: "workspace" as const,
        scopeId: workspaceId,
        scopeName: workspace.name,
        revision: metadata.revision,
      };
      const variables = await this.#variables.redactedVariables(
        database,
        "workspace",
        workspaceId,
      );
      for (const variable of variables) {
        inherited.set(variable.name, { variable, source });
      }
    }
    const composition = await this.#composeEnvironment(
      database,
      workspaceId,
      environmentId,
      (includedEnvironmentId) =>
        this.#variables.redactedVariables(
          database,
          "environment",
          includedEnvironmentId,
        ),
      false,
    );
    for (const variable of composition.variables) {
      const source = composition.sources.get(variable.name);
      if (source !== undefined) {
        inherited.set(variable.name, {
          variable,
          source: environmentPreviewSource(source),
        });
      }
    }
    return [...inherited.values()];
  }

  /** Lists direct includes in their low-to-high precedence order. */
  async #directIncludes(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    environmentId: EntityId,
  ): Promise<readonly EnvironmentSummary[]> {
    const rows = await database
      .selectFrom("environment_includes as include")
      .innerJoin(
        "environments as environment",
        "environment.id",
        "include.included_environment_id",
      )
      .select(["environment.id", "environment.name", "environment.revision"])
      .where("include.environment_id", "=", idToBytes(environmentId))
      .orderBy("include.position")
      .execute();
    return rows.map((row) => ({
      environmentId: bytesToId(row.id),
      name: row.name,
      revision: row.revision,
    }));
  }
}

/** Converts environment metadata into the shared variable-source contract. */
function environmentPreviewSource(
  source: SelectedEnvironmentProfileMetadata,
): VariablePreviewSource {
  return {
    scope: "environment",
    scopeId: source.environmentId,
    scopeName: source.name,
    revision: source.revision,
  };
}

/** Merges a composed profile and retains the highest-precedence evidence path. */
function mergeComposedProfile<T extends NamedEnvironmentVariable>(
  variables: Map<string, T>,
  sources: Map<string, SelectedEnvironmentProfileMetadata>,
  evidence: SelectedEnvironmentProfileMetadata[],
  profile: ComposedEnvironmentProfile<T>,
): void {
  for (const variable of profile.variables) {
    variables.set(variable.name, variable);
    const source = profile.sources.get(variable.name);
    if (source !== undefined) sources.set(variable.name, source);
  }
  mergeEnvironmentEvidence(evidence, profile.evidence);
}

/** Moves repeated diamond dependencies to their last, highest-precedence use. */
function mergeEnvironmentEvidence(
  evidence: SelectedEnvironmentProfileMetadata[],
  incoming: readonly SelectedEnvironmentProfileMetadata[],
): void {
  for (const source of incoming) {
    const existing = evidence.findIndex(
      (candidate) => candidate.environmentId === source.environmentId,
    );
    if (existing >= 0) evidence.splice(existing, 1);
    evidence.push(source);
  }
}

/** Finds the first cycle reachable from one changed environment. */
function findEnvironmentCycle(
  environmentId: EntityId,
  edges: ReadonlyMap<EntityId, readonly EntityId[]>,
): readonly EntityId[] | null {
  const stack: EntityId[] = [];
  const complete = new Set<EntityId>();

  /** Visits one reachable node and returns the active recursion cycle. */
  const visit = (currentId: EntityId): readonly EntityId[] | null => {
    const cycleStart = stack.indexOf(currentId);
    if (cycleStart >= 0) return [...stack.slice(cycleStart), currentId];
    if (complete.has(currentId)) return null;
    stack.push(currentId);
    for (const includedId of edges.get(currentId) ?? []) {
      const cycle = visit(includedId);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    complete.add(currentId);
    return null;
  };

  return visit(environmentId);
}

/** Produces the database-independent case-insensitive environment name key. */
export function environmentNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
