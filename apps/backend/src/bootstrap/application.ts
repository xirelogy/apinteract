import type { BackendConfiguration } from "../config.js";
import { AuditService } from "../audit/audit-service.js";
import { LocalBlobStore } from "../blobs/local-blob-store.js";
import { ExecutionService } from "../executions/execution-service.js";
import { EnvironmentService } from "../environments/environment-service.js";
import { IdentityService } from "../identity/identity-service.js";
import { SqliteDatabase } from "../persistence/sqlite-database.js";
import { ProxyClient } from "../proxy/proxy-client.js";
import { ScriptService } from "../scripting/script-service.js";
import { RequestService } from "../requests/request-service.js";
import { RequestAttachmentService } from "../requests/request-attachment-service.js";
import { SessionService } from "../sessions/session-service.js";
import { VariableService } from "../variables/variable-service.js";
import { WorkspaceService } from "../workspaces/workspace-service.js";

export interface Application {
  readonly database: SqliteDatabase;
  readonly audit: AuditService;
  readonly blobs: LocalBlobStore;
  readonly identity: IdentityService;
  readonly sessions: SessionService;
  readonly workspaces: WorkspaceService;
  readonly environments: EnvironmentService;
  readonly variables: VariableService;
  readonly requestAttachments: RequestAttachmentService;
  readonly requests: RequestService;
  readonly executions: ExecutionService;
  readonly proxy: ProxyClient;
  readonly scripts: ScriptService;
  close(): Promise<void>;
}

/** Initializes backend infrastructure and wires the application service graph. */
export async function createApplication(
  configuration: BackendConfiguration,
): Promise<Application> {
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
  const identity = new IdentityService(database.db, audit);
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
  );

  return {
    database,
    audit,
    blobs,
    identity,
    sessions,
    workspaces,
    environments,
    variables,
    requestAttachments,
    requests,
    executions,
    proxy,
    scripts,
    close: async () => {
      await executions.close();
      await scripts.close();
      await audit.publishPending();
      await database.close();
    },
  };
}
