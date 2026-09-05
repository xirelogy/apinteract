import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import type {
  AuthProviderBackendPluginModule,
  AuthProviderBackendServices,
} from "@apinteract/plugin-api/backend/authentication";
import type { AuthProviderPluginPackageManifest } from "@apinteract/plugin-api";

import { AuthenticationService } from "../src/authentication/authentication-service.js";
import { AuthProviderRegistry } from "../src/authentication/auth-provider-registry.js";
import { createApplication } from "../src/bootstrap/application.js";
import type { BackendConfiguration } from "../src/config.js";
import type { IdentityService } from "../src/identity/identity-service.js";
import { SqliteDatabase } from "../src/persistence/sqlite-database.js";
import { createBackendServer } from "../src/transport/server.js";

describe("authentication provider integration", () => {
  it("creates, proves, and updates local-password material through the plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "apinteract-auth-provider-"));
    const configuration = testConfiguration(root);
    const application = await createApplication(configuration);
    try {
      const initialized = await application.identity.initializeAdministrator(
        "admin",
        "Administrator",
        "local-password",
        { username: "admin", password: "first password" },
      );
      expect(initialized.username).toBe("admin");

      const authenticated = await application.authentication.begin(
        "local-password",
        { username: "admin", password: "first password" },
        "first-client",
      );
      expect(authenticated).toMatchObject({
        status: "authenticated",
        user: { id: initialized.id, username: "admin" },
      });

      await application.identity.updateCredential("admin", "local-password", {
        username: "admin",
        password: "second password",
      });
      await expect(
        application.authentication.begin(
          "local-password",
          { username: "admin", password: "first password" },
          "second-client",
        ),
      ).resolves.toEqual({ status: "rejected" });
      await expect(
        application.authentication.begin(
          "local-password",
          { username: "admin", password: "second password" },
          "third-client",
        ),
      ).resolves.toMatchObject({ status: "authenticated" });
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes the configured auth bundle and issues sessions through generic HTTP", async () => {
    const root = await mkdtemp(join(tmpdir(), "apinteract-auth-http-"));
    const configuration = testConfiguration(root);
    const application = await createApplication(configuration);
    await application.identity.initializeAdministrator(
      "admin",
      "Administrator",
      "local-password",
      { username: "admin", password: "test password" },
    );
    const server = await createBackendServer(application, configuration);
    try {
      const catalogResponse = await server.inject({
        method: "GET",
        url: "/auth/providers",
      });
      expect(catalogResponse.statusCode).toBe(200);
      const catalog = catalogResponse.json<{
        providers: Array<{
          descriptor: { id: string; pluginId: string };
          moduleUrl: string;
        }>;
      }>();
      expect(catalog.providers).toHaveLength(1);
      expect(catalog.providers[0]).toMatchObject({
        descriptor: {
          id: "local-password",
          pluginId: "builtin.local-password",
        },
      });
      expect(catalog.providers[0]!.moduleUrl).toMatch(
        /^\/auth\/plugins\/builtin\.local-password\/[a-f0-9]{64}\/frontend\.mjs$/u,
      );

      const moduleResponse = await server.inject({
        method: "GET",
        url: catalog.providers[0]!.moduleUrl,
      });
      expect(moduleResponse.statusCode).toBe(200);
      expect(moduleResponse.headers["cache-control"]).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(moduleResponse.headers["content-type"]).toContain("javascript");

      const wrongOrigin = await server.inject({
        method: "POST",
        url: "/auth/attempts",
        headers: {
          origin: "https://untrusted.example",
          "content-type": "application/json",
        },
        payload: {
          providerId: "local-password",
          fields: { username: "admin", password: "test password" },
        },
      });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(wrongOrigin.json()).toMatchObject({ code: "origin_not_allowed" });

      const loginResponse = await server.inject({
        method: "POST",
        url: "/auth/attempts",
        headers: {
          origin: configuration.server.publicOrigin,
          "content-type": "application/json",
        },
        payload: {
          providerId: "local-password",
          fields: { username: "admin", password: "test password" },
        },
      });
      expect(loginResponse.statusCode).toBe(200);
      expect(loginResponse.json()).toMatchObject({
        status: "authenticated",
        credential: { session: { user: { username: "admin" } } },
      });
      const setCookie = loginResponse.headers["set-cookie"];
      expect(
        Array.isArray(setCookie) ? setCookie.join(";") : setCookie,
      ).toContain("apinteract_refresh=");
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds, single-claims, cancels, and deletes provider attempt state", async () => {
    const root = await mkdtemp(join(tmpdir(), "apinteract-auth-attempt-"));
    const database = await SqliteDatabase.open(
      join(root, "database.sqlite3"),
      join(root, "backups"),
    );
    const continued: unknown[] = [];
    const cancelled: unknown[] = [];
    const providers = new AuthProviderRegistry();
    providers.install(
      testAuthManifest,
      testInteractionModule(continued, cancelled),
      "built-in",
    );
    await providers.initialize([testAuthConfiguration], () => testServices);
    const authentication = new AuthenticationService(database.db, providers, {
      resolveAssertion: () =>
        Promise.reject(new Error("This test never authenticates")),
    } as unknown as IdentityService);
    try {
      const started = await authentication.begin(
        "test-auth",
        { username: "example" },
        "client",
      );
      expect(started.status).toBe("interaction_required");
      if (started.status !== "interaction_required") return;

      const transitions = await Promise.all([
        authentication.continue(
          started.attemptId,
          started.binding,
          { answer: "wrong" },
          "client",
        ),
        authentication.continue(
          started.attemptId,
          started.binding,
          { answer: "wrong" },
          "client",
        ),
      ]);
      expect(transitions).toEqual([
        { status: "rejected" },
        { status: "rejected" },
      ]);
      expect(continued).toHaveLength(1);
      expect(await attemptCount(database)).toBe(0);

      const cancellable = await authentication.begin(
        "test-auth",
        { username: "example" },
        "second-client",
      );
      expect(cancellable.status).toBe("interaction_required");
      if (cancellable.status !== "interaction_required") return;
      await authentication.cancel(cancellable.attemptId, cancellable.binding);
      expect(cancelled).toHaveLength(1);
      expect(await attemptCount(database)).toBe(0);
    } finally {
      await providers.close();
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

const testAuthManifest: AuthProviderPluginPackageManifest = {
  schemaVersion: 2,
  apiVersion: 1,
  id: "builtin.test-auth",
  name: "Test authentication",
  version: "1.0.0",
  target: "auth-provider",
  entrypoints: { backend: "dist/backend.mjs", frontend: "dist/frontend.mjs" },
  providers: {
    backend: ["authentication.provider"],
    frontend: ["authentication.login"],
  },
};

const testAuthConfiguration = {
  id: "test-auth",
  plugin: "builtin.test-auth",
  label: "Test authentication",
  configuration: {},
} as const;

const testServices: AuthProviderBackendServices = {
  clock: { now: () => Date.now() },
  secureRandom: { bytes: (length) => new Uint8Array(length) },
  passwords: {
    hash: (password) => Promise.resolve(password),
    verify: (password, encodedHash) =>
      Promise.resolve(password === encodedHash),
  },
  credentials: { findByLookupKey: () => Promise.resolve(null) },
};

/** Builds a deterministic two-step provider used to prove core attempt ownership. */
function testInteractionModule(
  continued: unknown[],
  cancelled: unknown[],
): AuthProviderBackendPluginModule {
  return {
    /** Registers the test provider's single backend contribution. */
    register(context) {
      context.register("authentication.provider", {
        configurationSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        /** Creates an interaction runtime whose state transitions are observable. */
        createInstance() {
          return {
            publicConfiguration: () => ({}),
            begin: () =>
              Promise.resolve({
                status: "interaction_required",
                state: { schemaVersion: 1, data: { nonce: "opaque" } },
                publicData: { prompt: "Answer" },
              }),
            continue: (state) => {
              continued.push(state);
              return Promise.resolve({
                status: "rejected",
                internalCode: "wrong_answer",
              });
            },
            cancel: (state) => {
              cancelled.push(state);
            },
          };
        },
      });
    },
  };
}

/** Counts retained provider states without exposing their opaque contents. */
async function attemptCount(database: SqliteDatabase): Promise<number> {
  const row = await database.db
    .selectFrom("authentication_attempts")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** Builds one isolated backend configuration using packaged built-in plugins. */
function testConfiguration(root: string): BackendConfiguration {
  return {
    configVersion: 1,
    server: {
      host: "127.0.0.1",
      port: 8080,
      publicOrigin: "http://localhost:8080",
    },
    persistence: {
      databasePath: join(root, "database.sqlite3"),
      migrationBackupDirectory: join(root, "backups"),
    },
    blobs: {
      rootPath: join(root, "blobs"),
      stagingPath: join(root, "staging"),
    },
    audit: { rootPath: join(root, "audit") },
    proxy: { endpoint: "http://proxy.invalid", bearerToken: "test-token" },
    sessions: {
      secureCookie: false,
      accessLifetimeSeconds: 900,
      refreshIdleLifetimeSeconds: 604_800,
      refreshAbsoluteLifetimeSeconds: 2_592_000,
    },
    frontend: { distPath: join(root, "frontend") },
    plugins: {
      builtinPath: resolve(import.meta.dirname, "../../../plugins"),
      userPath: join(root, "user-plugins"),
    },
    authentication: {
      providers: [
        {
          id: "local-password",
          plugin: "builtin.local-password",
          label: "Username and password",
          configuration: {},
        },
      ],
    },
  };
}
