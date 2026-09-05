import type { BackendConfiguration } from "../config.js";
import { randomBytes } from "node:crypto";
import { AuditService } from "../audit/audit-service.js";
import { AuthenticationService } from "../authentication/authentication-service.js";
import { AuthProviderRegistry } from "../authentication/auth-provider-registry.js";
import { CredentialRepository } from "../authentication/credential-repository.js";
import { LocalBlobStore } from "../blobs/local-blob-store.js";
import { ExecutionService } from "../executions/execution-service.js";
import { EnvironmentService } from "../environments/environment-service.js";
import { RequestExchangeService } from "../exchanges/request-exchange-service.js";
import { IdentityService } from "../identity/identity-service.js";
import { hashPassword, verifyPassword } from "../foundation/password.js";
import { ImportService } from "../imports/import-service.js";
import { SqliteDatabase } from "../persistence/sqlite-database.js";
import { ProxyClient } from "../proxy/proxy-client.js";
import { ScriptService } from "../scripting/script-service.js";
import { RequestService } from "../requests/request-service.js";
import { RequestAttachmentService } from "../requests/request-attachment-service.js";
import { SessionService } from "../sessions/session-service.js";
import { VariableService } from "../variables/variable-service.js";
import { WorkspaceService } from "../workspaces/workspace-service.js";
import { createBackendPluginRuntime } from "../plugins/backend-plugin-host.js";
import {
  discoverPluginPackages,
  loadAuthProviderBackendModule,
  loadBackendPluginModule,
} from "../plugins/plugin-discovery.js";
import { PluginService } from "../plugins/plugin-service.js";

export interface Application {
  readonly database: SqliteDatabase;
  readonly audit: AuditService;
  readonly blobs: LocalBlobStore;
  readonly identity: IdentityService;
  readonly authentication: AuthenticationService;
  readonly authProviders: AuthProviderRegistry;
  readonly sessions: SessionService;
  readonly workspaces: WorkspaceService;
  readonly environments: EnvironmentService;
  readonly variables: VariableService;
  readonly requestAttachments: RequestAttachmentService;
  readonly requests: RequestService;
  readonly imports: ImportService;
  readonly executions: ExecutionService;
  readonly requestExchanges: RequestExchangeService;
  readonly proxy: ProxyClient;
  readonly scripts: ScriptService;
  readonly plugins: PluginService;
  close(): Promise<void>;
}

/** Initializes backend infrastructure and wires the application service graph. */
export async function createApplication(
  configuration: BackendConfiguration,
): Promise<Application> {
  const pluginPaths = configuration.plugins ?? {
    builtinPath: "/opt/apinteract/plugins",
    userPath: "/data/plugins",
  };
  const database = await SqliteDatabase.open(
    configuration.persistence.databasePath,
    configuration.persistence.migrationBackupDirectory,
  );
  const audit = new AuditService(database.db, configuration.audit.rootPath);
  const blobs = new LocalBlobStore(
    configuration.blobs.rootPath,
    configuration.blobs.stagingPath,
  );
  await blobs.initialize();
  const sessions = new SessionService(database.db, audit, {
    accessLifetimeSeconds: configuration.sessions.accessLifetimeSeconds,
    refreshIdleLifetimeSeconds:
      configuration.sessions.refreshIdleLifetimeSeconds,
    refreshAbsoluteLifetimeSeconds:
      configuration.sessions.refreshAbsoluteLifetimeSeconds,
  });
  await sessions.initialize(configuration.server.publicOrigin);
  const workspaces = new WorkspaceService(database.db, audit);
  const environments = new EnvironmentService(database.db, workspaces, audit);
  const variables = new VariableService(
    database.db,
    workspaces,
    environments,
    audit,
  );
  const requestAttachments = new RequestAttachmentService(
    database.db,
    workspaces,
    blobs,
    audit,
  );
  const requests = new RequestService(
    database.db,
    workspaces,
    variables,
    audit,
    requestAttachments,
  );
  const discoveredPlugins = await discoverPluginPackages(
    [
      { path: pluginPaths.builtinPath, source: "built-in" },
      { path: pluginPaths.userPath, source: "user" },
    ],
    (path, cause) => {
      process.stderr.write(
        `Ignoring invalid plugin package ${path}: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    },
  );
  const pluginRuntime = createBackendPluginRuntime();
  const authProviders = new AuthProviderRegistry();
  for (const plugin of discoveredPlugins) {
    if (plugin.manifest.target === "auth-provider") {
      authProviders.install(
        plugin.manifest,
        await loadAuthProviderBackendModule(plugin),
        plugin.source,
      );
      continue;
    }
    if (plugin.manifest.target !== "backend") continue;
    try {
      pluginRuntime.plugins.install(
        plugin.manifest as typeof plugin.manifest & { target: "backend" },
        await loadBackendPluginModule(plugin),
        plugin.source,
      );
    } catch (cause) {
      process.stderr.write(
        `Ignoring backend plugin ${plugin.manifest.id}: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    }
  }
  pluginRuntime.plugins.validateCapabilities();
  const credentials = new CredentialRepository(database.db);
  const configuredAuthProviders = configuration.authentication?.providers ?? [
    {
      id: "local-password",
      plugin: "builtin.local-password",
      label: "Username and password",
      description: "Sign in with your APInteract username and password.",
      configuration: {},
    },
  ];
  await authProviders.initialize(configuredAuthProviders, (instanceId) => ({
    clock: { now: () => Date.now() },
    secureRandom: { bytes: secureRandomBytes },
    passwords: { hash: hashPassword, verify: verifyPassword },
    credentials: credentials.reader(instanceId),
  }));
  const identity = new IdentityService(
    database.db,
    audit,
    authProviders,
    credentials,
  );
  const authentication = new AuthenticationService(
    database.db,
    authProviders,
    identity,
  );
  const plugins = new PluginService(pluginRuntime.plugins, discoveredPlugins);
  const imports = new ImportService(requests, pluginRuntime.imports);
  const proxy = new ProxyClient(
    configuration.proxy.endpoint,
    configuration.proxy.bearerToken,
  );
  const scripts = new ScriptService();
  const executions = new ExecutionService(
    database.db,
    requests,
    workspaces,
    proxy,
    blobs,
    audit,
    scripts,
    {
      variables,
      ...(configuration.scripts === undefined
        ? {}
        : { policy: configuration.scripts.variableWrites }),
    },
  );
  const requestExchanges = new RequestExchangeService(
    database.db,
    workspaces,
    blobs,
  );

  return {
    database,
    audit,
    blobs,
    identity,
    authentication,
    authProviders,
    sessions,
    workspaces,
    environments,
    variables,
    requestAttachments,
    requests,
    imports,
    executions,
    requestExchanges,
    proxy,
    scripts,
    plugins,
    close: async () => {
      await executions.close();
      await scripts.close();
      await audit.publishPending();
      await authProviders.close();
      await database.close();
    },
  };
}

/** Returns bounded cryptographic randomness to a built-in provider runtime. */
function secureRandomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 1 || length > 4096) {
    throw new Error("Authentication provider requested invalid random bytes");
  }
  return randomBytes(length);
}
