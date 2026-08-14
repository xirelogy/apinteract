import type { Kysely, Transaction } from "kysely";

import type { AuditService } from "../audit/audit-service.js";
import type { EnvironmentService } from "../environments/environment-service.js";
import { VariableResolver } from "../environments/variable-resolver.js";
import { bytesToId, idToBytes, type EntityId } from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";
import { ResourceNotFoundError } from "../workspaces/workspace-service.js";
import {
  type ResolvedVariable,
  type SecretMutation,
  type VariableScopeKind,
  VariableProfileConflictError,
  VariableProfileStore,
  type VariableView,
  type VariableWrite,
  validateVariableName,
} from "./variable-profile-store.js";

export type EditableVariableScopeKind = "workspace" | "collection" | "request";

export interface VariableProfileView {
  readonly workspaceId: EntityId;
  readonly scopeKind: EditableVariableScopeKind;
  readonly scopeId: EntityId;
  readonly scopeName: string;
  readonly revision: number;
  readonly variables: readonly VariableView[];
  readonly inheritedVariables: readonly InheritedVariableView[];
}

/** Describes one effective lower-precedence variable and its persisted source. */
export interface InheritedVariableView {
  readonly variable: VariableView;
  readonly source: VariablePreviewSource;
}

/** Identifies the highest-precedence persisted scope supplying a variable. */
export interface VariablePreviewSource {
  readonly scope: VariableScopeKind;
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

export interface VariablePreviewResult {
  readonly previews: readonly VariablePreview[];
}

export interface VariableProfileEvidence {
  readonly scope: VariableScopeKind;
  readonly scopeId: EntityId;
  readonly revision: number;
}

export interface EffectiveVariableProfile {
  readonly variables: readonly ResolvedVariable[];
  readonly sources: ReadonlyMap<string, VariablePreviewSource>;
  readonly evidence: readonly VariableProfileEvidence[];
}

interface ScopeIdentity {
  readonly workspaceId: EntityId;
  readonly scopeKind: EditableVariableScopeKind;
  readonly scopeId: EntityId;
  readonly scopeName: string;
  readonly parentCollectionId: EntityId | null;
}

interface VariableLayer {
  readonly source: VariablePreviewSource;
  readonly variables: readonly ResolvedVariable[];
}

interface RedactedVariableLayer {
  readonly source: VariablePreviewSource;
  readonly variables: readonly VariableView[];
}

/** Describes an authorized request-profile clone owned by a larger transaction. */
interface RequestProfileCloneOptions {
  readonly userId: EntityId;
  readonly workspaceId: EntityId;
  readonly sourceRequestId: EntityId;
  readonly targetRequestId: EntityId;
  readonly targetRequestName: string;
}

/** Owns persisted workspace, collection, and request variable profiles. */
export class VariableService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #workspaces: WorkspaceService;
  readonly #environments: EnvironmentService;
  readonly #audit: AuditService;
  readonly #profiles: VariableProfileStore;

  constructor(
    database: Kysely<DatabaseSchema>,
    workspaces: WorkspaceService,
    environments: EnvironmentService,
    audit: AuditService,
  ) {
    this.#database = database;
    this.#workspaces = workspaces;
    this.#environments = environments;
    this.#audit = audit;
    this.#profiles = new VariableProfileStore(database);
  }

  /** Loads one authorized profile with secret values redacted. */
  async get(
    userId: EntityId,
    scopeKind: EditableVariableScopeKind,
    scopeId: EntityId,
    sessionId: EntityId | null = null,
  ): Promise<VariableProfileView> {
    const identity = await this.#scopeIdentity(
      this.#database,
      scopeKind,
      scopeId,
    );
    await this.#workspaces.requireCanRead(
      this.#database,
      userId,
      identity.workspaceId,
    );
    return this.#view(this.#database, identity, sessionId);
  }

  /** Replaces one authorized ordered profile under optimistic concurrency. */
  async update(
    userId: EntityId,
    scopeKind: EditableVariableScopeKind,
    scopeId: EntityId,
    expectedRevision: number,
    variables: readonly VariableWrite[],
    sessionId: EntityId | null = null,
  ): Promise<VariableProfileView> {
    return this.#database
      .transaction()
      .execute((transaction) =>
        this.updateInTransaction(
          transaction,
          userId,
          scopeKind,
          scopeId,
          expectedRevision,
          variables,
          sessionId,
        ),
      );
  }

  /** Replaces one profile inside a caller-owned transaction and audit boundary. */
  async updateInTransaction(
    transaction: Transaction<DatabaseSchema>,
    userId: EntityId,
    scopeKind: EditableVariableScopeKind,
    scopeId: EntityId,
    expectedRevision: number,
    variables: readonly VariableWrite[],
    sessionId: EntityId | null = null,
  ): Promise<VariableProfileView> {
    const identity = await this.#scopeIdentity(transaction, scopeKind, scopeId);
    await this.#workspaces.requireCanEdit(
      transaction,
      userId,
      identity.workspaceId,
    );
    const metadata = await this.#profiles.metadata(
      transaction,
      scopeKind,
      scopeId,
    );
    let revision: number;
    let mutations: readonly SecretMutation[];
    if (metadata === null) {
      if (expectedRevision !== 0) {
        throw new VariableProfileConflictError("The variable profile changed");
      }
      revision = 1;
      mutations = await this.#profiles.create(
        transaction,
        identity.workspaceId,
        scopeKind,
        scopeId,
        revision,
        userId,
        variables,
      );
    } else {
      ({ revision, mutations } = await this.#profiles.replace(
        transaction,
        scopeKind,
        scopeId,
        expectedRevision,
        userId,
        variables,
      ));
    }
    await this.#audit.record(transaction, {
      type: "variable_profile.updated",
      actorUserId: userId,
      workspaceId: identity.workspaceId,
      data: { scopeKind, scopeId, revision },
    });
    await this.#recordSecretMutations(transaction, userId, identity, mutations);
    return this.#view(transaction, identity, sessionId);
  }

  /** Clones a request profile inside an already authorized caller transaction. */
  async cloneRequestProfile(
    transaction: Transaction<DatabaseSchema>,
    options: RequestProfileCloneOptions,
  ): Promise<void> {
    const mutations = await this.#profiles.clone(transaction, {
      workspaceId: options.workspaceId,
      scopeKind: "request",
      sourceScopeId: options.sourceRequestId,
      targetScopeId: options.targetRequestId,
      userId: options.userId,
    });
    if (mutations === null) return;
    const identity: ScopeIdentity = {
      workspaceId: options.workspaceId,
      scopeKind: "request",
      scopeId: options.targetRequestId,
      scopeName: options.targetRequestName,
      parentCollectionId: null,
    };
    await this.#audit.record(transaction, {
      type: "variable_profile.duplicated",
      actorUserId: options.userId,
      workspaceId: options.workspaceId,
      data: {
        scopeKind: "request",
        sourceScopeId: options.sourceRequestId,
        scopeId: options.targetRequestId,
        revision: 1,
      },
    });
    await this.#recordSecretMutations(
      transaction,
      options.userId,
      identity,
      mutations,
    );
  }

  /** Resolves requested names across every applicable persisted scope. */
  async previewVariables(
    userId: EntityId,
    sessionId: EntityId,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
    requestId: EntityId | null,
    names: readonly string[],
  ): Promise<VariablePreviewResult> {
    await this.#workspaces.requireCanRead(this.#database, userId, workspaceId);
    const profile = await this.effectiveProfile(
      this.#database,
      sessionId,
      workspaceId,
      parentCollectionId,
      requestId,
    );
    const variables = new Map(
      profile.variables.map((variable) => [variable.name, variable] as const),
    );
    const resolver = new VariableResolver(profile.variables);
    return {
      previews: names.map((name) => {
        validateVariableName(name);
        const variable = variables.get(name);
        const source = profile.sources.get(name) ?? null;
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
            status: "unset" as const,
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
            status: "resolved" as const,
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
            status: "error" as const,
            effectiveKind:
              variable.kind === "secret" ? ("secret" as const) : null,
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

  /** Builds the deterministic low-to-high merged profile for composition. */
  async effectiveProfile(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    sessionId: EntityId,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
    requestId: EntityId | null,
  ): Promise<EffectiveVariableProfile> {
    let effectiveParent = parentCollectionId;
    let requestIdentity: ScopeIdentity | null = null;
    if (requestId !== null) {
      requestIdentity = await this.#scopeIdentity(
        database,
        "request",
        requestId,
      );
      if (requestIdentity.workspaceId !== workspaceId) {
        throw new ResourceNotFoundError("Request not found");
      }
      effectiveParent = requestIdentity.parentCollectionId;
    }
    const workspace = await database
      .selectFrom("workspaces")
      .select("name")
      .where("id", "=", idToBytes(workspaceId))
      .executeTakeFirst();
    if (workspace === undefined) {
      throw new ResourceNotFoundError("Workspace not found");
    }
    const layers: VariableLayer[] = [];
    await this.#appendLayer(
      database,
      layers,
      "workspace",
      workspaceId,
      workspace.name,
    );
    const environment = await this.#environments.selectedProfile(
      database,
      sessionId,
      workspaceId,
    );
    if (environment !== null) {
      layers.push({
        source: {
          scope: "environment",
          scopeId: environment.environmentId,
          scopeName: environment.name,
          revision: environment.revision,
        },
        variables: environment.variables,
      });
    }
    const collections = await this.#collectionPath(
      database,
      workspaceId,
      effectiveParent,
    );
    for (const collection of collections) {
      await this.#appendLayer(
        database,
        layers,
        "collection",
        collection.collectionId,
        collection.name,
      );
    }
    if (requestIdentity !== null) {
      await this.#appendLayer(
        database,
        layers,
        "request",
        requestIdentity.scopeId,
        requestIdentity.scopeName,
      );
    }
    const variables = new Map<string, ResolvedVariable>();
    const sources = new Map<string, VariablePreviewSource>();
    for (const layer of layers) {
      for (const variable of layer.variables) {
        variables.set(variable.name, variable);
        sources.set(variable.name, layer.source);
      }
    }
    return {
      variables: [...variables.values()],
      sources,
      evidence: layers.map((layer) => ({
        scope: layer.source.scope,
        scopeId: layer.source.scopeId,
        revision: layer.source.revision,
      })),
    };
  }

  /** Appends one non-empty or revisioned persisted profile layer. */
  async #appendLayer(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    layers: VariableLayer[],
    scope: EditableVariableScopeKind,
    scopeId: EntityId,
    scopeName: string,
  ): Promise<void> {
    const metadata = await this.#profiles.metadata(database, scope, scopeId);
    if (metadata === null) {
      return;
    }
    layers.push({
      source: { scope, scopeId, scopeName, revision: metadata.revision },
      variables: await this.#profiles.resolvedVariables(
        database,
        scope,
        scopeId,
      ),
    });
  }

  /** Returns a root-first collection path while rejecting corrupt hierarchies. */
  async #collectionPath(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    workspaceId: EntityId,
    parentCollectionId: EntityId | null,
  ): Promise<
    readonly { readonly collectionId: EntityId; readonly name: string }[]
  > {
    const path: { collectionId: EntityId; name: string }[] = [];
    const visited = new Set<EntityId>();
    let currentId = parentCollectionId;
    while (currentId !== null) {
      if (visited.has(currentId) || visited.size >= 64) {
        throw new Error("Collection hierarchy is cyclic or too deep");
      }
      visited.add(currentId);
      const row = await database
        .selectFrom("workspace_tree_nodes")
        .select(["id", "workspace_id", "parent_collection_id", "name"])
        .where("id", "=", idToBytes(currentId))
        .where("kind", "=", "collection")
        .executeTakeFirst();
      if (row === undefined || bytesToId(row.workspace_id) !== workspaceId) {
        throw new ResourceNotFoundError("Parent collection not found");
      }
      path.unshift({ collectionId: bytesToId(row.id), name: row.name });
      currentId =
        row.parent_collection_id === null
          ? null
          : bytesToId(row.parent_collection_id);
    }
    return path;
  }

  /** Resolves one editable scope's workspace ownership and display name. */
  async #scopeIdentity(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    scopeKind: EditableVariableScopeKind,
    scopeId: EntityId,
  ): Promise<ScopeIdentity> {
    if (scopeKind === "workspace") {
      const row = await database
        .selectFrom("workspaces")
        .select(["id", "name"])
        .where("id", "=", idToBytes(scopeId))
        .executeTakeFirst();
      if (row === undefined) {
        throw new ResourceNotFoundError("Workspace not found");
      }
      return {
        workspaceId: bytesToId(row.id),
        scopeKind,
        scopeId,
        scopeName: row.name,
        parentCollectionId: null,
      };
    }
    const row = await database
      .selectFrom("workspace_tree_nodes")
      .select(["id", "workspace_id", "parent_collection_id", "name", "kind"])
      .where("id", "=", idToBytes(scopeId))
      .where("kind", "=", scopeKind)
      .executeTakeFirst();
    if (row === undefined) {
      throw new ResourceNotFoundError(
        scopeKind === "collection"
          ? "Collection not found"
          : "Request not found",
      );
    }
    return {
      workspaceId: bytesToId(row.workspace_id),
      scopeKind,
      scopeId,
      scopeName: row.name,
      parentCollectionId:
        row.parent_collection_id === null
          ? null
          : bytesToId(row.parent_collection_id),
    };
  }

  /** Builds a redacted API view for one already authorized scope. */
  async #view(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    identity: ScopeIdentity,
    sessionId: EntityId | null,
  ): Promise<VariableProfileView> {
    const metadata = await this.#profiles.metadata(
      database,
      identity.scopeKind,
      identity.scopeId,
    );
    return {
      workspaceId: identity.workspaceId,
      scopeKind: identity.scopeKind,
      scopeId: identity.scopeId,
      scopeName: identity.scopeName,
      revision: metadata?.revision ?? 0,
      variables: await this.#profiles.redactedVariables(
        database,
        identity.scopeKind,
        identity.scopeId,
      ),
      inheritedVariables: await this.#inheritedVariables(
        database,
        sessionId,
        identity,
      ),
    };
  }

  /** Builds the effective lower-precedence profile visible beneath one scope. */
  async #inheritedVariables(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    sessionId: EntityId | null,
    identity: ScopeIdentity,
  ): Promise<readonly InheritedVariableView[]> {
    if (identity.scopeKind === "workspace") return [];

    const workspace = await database
      .selectFrom("workspaces")
      .select("name")
      .where("id", "=", idToBytes(identity.workspaceId))
      .executeTakeFirstOrThrow();
    const layers: RedactedVariableLayer[] = [];
    await this.#appendRedactedLayer(
      database,
      layers,
      "workspace",
      identity.workspaceId,
      workspace.name,
    );

    if (sessionId !== null) {
      const environment = await this.#environments.selectedProfileMetadata(
        database,
        sessionId,
        identity.workspaceId,
      );
      if (environment !== null) {
        await this.#appendRedactedLayer(
          database,
          layers,
          "environment",
          environment.environmentId,
          environment.name,
        );
      }
    }

    const collections = await this.#collectionPath(
      database,
      identity.workspaceId,
      identity.parentCollectionId,
    );
    for (const collection of collections) {
      await this.#appendRedactedLayer(
        database,
        layers,
        "collection",
        collection.collectionId,
        collection.name,
      );
    }

    const inherited = new Map<string, InheritedVariableView>();
    for (const layer of layers) {
      for (const variable of layer.variables) {
        inherited.set(variable.name, { variable, source: layer.source });
      }
    }
    return [...inherited.values()];
  }

  /** Appends one persisted layer with secrets redacted for editor display. */
  async #appendRedactedLayer(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    layers: RedactedVariableLayer[],
    scope: VariableScopeKind,
    scopeId: EntityId,
    scopeName: string,
  ): Promise<void> {
    const metadata = await this.#profiles.metadata(database, scope, scopeId);
    if (metadata === null) return;
    layers.push({
      source: { scope, scopeId, scopeName, revision: metadata.revision },
      variables: await this.#profiles.redactedVariables(
        database,
        scope,
        scopeId,
      ),
    });
  }

  /** Records allowlisted secret lifecycle metadata without plaintext. */
  async #recordSecretMutations(
    transaction: Transaction<DatabaseSchema>,
    userId: EntityId,
    identity: ScopeIdentity,
    mutations: readonly SecretMutation[],
  ): Promise<void> {
    for (const mutation of mutations) {
      await this.#audit.record(transaction, {
        type: `secret_variable.${mutation.type}`,
        actorUserId: userId,
        workspaceId: identity.workspaceId,
        data: {
          scopeKind: identity.scopeKind,
          scopeId: identity.scopeId,
          variableId: mutation.variableId,
          secretVersion: mutation.version,
        },
      });
    }
  }
}
