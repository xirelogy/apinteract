import type { PluginRegistrationContext } from "@apinteract/plugin-api";
import type {
  AuthProviderBackendPluginProviders,
  AuthProviderCredentialCreation,
  AuthProviderCredentialMaterial,
  AuthProviderInput,
} from "@apinteract/plugin-api/backend/authentication";

const USERNAME_KEY = "username";

/** Registers the built-in local-password backend implementation. */
export function register(
  context: PluginRegistrationContext<AuthProviderBackendPluginProviders>,
): void {
  context.register("authentication.provider", {
    configurationSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    createInstance(instanceId, _configuration, services) {
      return {
        publicConfiguration: () => ({}),
        async begin(input) {
          const username = input.username;
          const password = input.password;
          if (!validUsername(username) || !validPassword(password)) {
            return { status: "rejected", internalCode: "invalid_credentials" };
          }
          const credential = await services.credentials.findByLookupKey(
            USERNAME_KEY,
            normalizeUsername(username),
          );
          if (
            credential === null ||
            !(await services.passwords.verify(
              password,
              passwordHash(credential.material),
            ))
          ) {
            return { status: "rejected", internalCode: "invalid_credentials" };
          }
          return {
            status: "authenticated",
            assertion: {
              providerInstanceId: instanceId,
              subject: credential.subject,
              authenticatedAt: services.clock.now(),
              authenticationMethods: ["password"],
            },
          };
        },
        credentials: {
          async create(input) {
            return createCredential(
              input,
              (password) => services.passwords.hash(password),
              () => hex(services.secureRandom.bytes(16)),
            );
          },
          async update(current, input) {
            const created = await createCredential(
              input,
              (password) => services.passwords.hash(password),
              () => current.subject,
            );
            return created;
          },
        },
      };
    },
  });
}

/** Creates one versioned credential record without selecting a core user. */
async function createCredential(
  input: AuthProviderInput,
  hash: (password: string) => Promise<string>,
  subject: () => string,
): Promise<AuthProviderCredentialCreation> {
  const username = input.username;
  const password = input.password;
  if (!validUsername(username) || !validPassword(password)) {
    throw new Error("Local-password credential input is invalid");
  }
  return {
    subject: subject(),
    lookupKeys: [{ key: USERNAME_KEY, value: normalizeUsername(username) }],
    material: {
      schemaVersion: 1,
      data: { passwordHash: await hash(password) },
    },
  };
}

/** Extracts the only private field owned by local-password schema version 1. */
function passwordHash(material: AuthProviderCredentialMaterial): string {
  const data = material.data;
  if (
    material.schemaVersion !== 1 ||
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    typeof (data as Record<string, unknown>).passwordHash !== "string"
  ) {
    throw new Error("Local-password credential material is incompatible");
  }
  return (data as Record<string, string>).passwordHash!;
}

/** Normalizes a mutable login identifier for provider-scoped lookup. */
function normalizeUsername(username: string): string {
  return username.normalize("NFKC").toLocaleLowerCase("en-US");
}

/** Bounds usernames before hashing or repository access. */
function validUsername(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

/** Bounds password evidence without imposing a composition policy. */
function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

/** Encodes cryptographic random bytes as an opaque stable subject. */
function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
