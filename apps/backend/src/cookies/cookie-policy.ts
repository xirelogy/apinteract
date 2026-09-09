import type { Kysely, Transaction } from "kysely";

import { idToBytes, type EntityId } from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";

export const DEFAULT_COOKIE_POLICY: ResolvedCookiePolicy = { enabled: true };
export const DEFAULT_COOKIE_CONCURRENCY_MODE: CookieConcurrencyMode =
  "optimistic";

export type CookieConcurrencyMode = "optimistic" | "serialized";

export interface CookiePolicyOverride {
  readonly enabled?: boolean;
}

export interface ResolvedCookiePolicy {
  readonly enabled: boolean;
}

/** Accepts only supported per-user cookie request admission modes. */
export function validateCookieConcurrencyMode(
  value: unknown,
): CookieConcurrencyMode {
  if (value === "optimistic" || value === "serialized") return value;
  throw new Error("HTTP cookie concurrency mode is invalid");
}

/** Loads the user's cookie request admission preference or its packaged default. */
export async function resolveCookieConcurrencyMode(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  userId: EntityId,
): Promise<CookieConcurrencyMode> {
  const preferences = await database
    .selectFrom("user_preferences")
    .select("cookie_concurrency_mode")
    .where("user_id", "=", idToBytes(userId))
    .executeTakeFirst();
  return (
    preferences?.cookie_concurrency_mode ?? DEFAULT_COOKIE_CONCURRENCY_MODE
  );
}

/** Validates one independently inheritable cookie-jar policy. */
export function validateCookiePolicyOverride(
  value: CookiePolicyOverride | undefined,
): CookiePolicyOverride {
  if (value === undefined) return {};
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "enabled") ||
    (value.enabled !== undefined && typeof value.enabled !== "boolean")
  ) {
    throw new Error("HTTP cookie policy is invalid");
  }
  return value.enabled === undefined ? {} : { enabled: value.enabled };
}

/** Requires a complete cookie policy for persisted user defaults. */
export function validateResolvedCookiePolicy(
  value: ResolvedCookiePolicy,
): ResolvedCookiePolicy {
  const parsed = validateCookiePolicyOverride(value);
  if (parsed.enabled === undefined) {
    throw new Error("HTTP cookie defaults must be complete");
  }
  return { enabled: parsed.enabled };
}

/** Parses a persisted cookie override without admitting damaged values. */
export function parseCookiePolicyOverride(value: string): CookiePolicyOverride {
  return validateCookiePolicyOverride(
    JSON.parse(value) as CookiePolicyOverride,
  );
}

/** Resolves request, workspace, user, and packaged cookie behavior. */
export async function resolveCookiePolicy(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  userId: EntityId,
  workspaceId: EntityId,
  request: CookiePolicyOverride,
): Promise<ResolvedCookiePolicy> {
  const [workspace, preferences] = await Promise.all([
    database
      .selectFrom("workspaces")
      .select("cookie_policy_json")
      .where("id", "=", idToBytes(workspaceId))
      .executeTakeFirstOrThrow(),
    database
      .selectFrom("user_preferences")
      .select("cookie_policy_json")
      .where("user_id", "=", idToBytes(userId))
      .executeTakeFirst(),
  ]);
  const workspacePolicy = parseCookiePolicyOverride(
    workspace.cookie_policy_json,
  );
  const userPolicy =
    preferences === undefined
      ? DEFAULT_COOKIE_POLICY
      : validateResolvedCookiePolicy(
          JSON.parse(preferences.cookie_policy_json) as ResolvedCookiePolicy,
        );
  return {
    enabled: request.enabled ?? workspacePolicy.enabled ?? userPolicy.enabled,
  };
}
