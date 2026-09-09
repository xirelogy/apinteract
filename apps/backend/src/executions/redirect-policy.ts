import type { Kysely, Transaction } from "kysely";

import type { AuditService } from "../audit/audit-service.js";
import {
  DEFAULT_COOKIE_POLICY,
  DEFAULT_COOKIE_CONCURRENCY_MODE,
  validateCookieConcurrencyMode,
  validateResolvedCookiePolicy,
  type CookieConcurrencyMode,
  type ResolvedCookiePolicy,
} from "../cookies/cookie-policy.js";
import { idToBytes, type EntityId } from "../foundation/id.js";
import type { DatabaseSchema } from "../persistence/schema.js";

export const MAX_REDIRECTS_HARD_LIMIT = 50;
export const DEFAULT_REDIRECT_POLICY: ResolvedRedirectPolicy = {
  follow: true,
  maxRedirects: 10,
};

export interface RedirectPolicyOverride {
  readonly follow?: boolean;
  readonly maxRedirects?: number;
}

export interface ResolvedRedirectPolicy {
  readonly follow: boolean;
  readonly maxRedirects: number;
}

export interface UserPreferencesView {
  readonly redirectPolicy: ResolvedRedirectPolicy;
  readonly cookiePolicy: ResolvedCookiePolicy;
  readonly cookieConcurrencyMode: CookieConcurrencyMode;
  readonly revision: number;
}

/** Raised when a user preference update races another committed update. */
export class UserPreferencesConflictError extends Error {}

/** Validates an independently inheritable redirect policy object. */
export function validateRedirectPolicyOverride(
  value: RedirectPolicyOverride | undefined,
): RedirectPolicyOverride {
  if (value === undefined) return {};
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => key !== "follow" && key !== "maxRedirects",
    ) ||
    (value.follow !== undefined && typeof value.follow !== "boolean") ||
    (value.maxRedirects !== undefined &&
      (!Number.isInteger(value.maxRedirects) ||
        value.maxRedirects < 0 ||
        value.maxRedirects > MAX_REDIRECTS_HARD_LIMIT))
  ) {
    throw new Error("HTTP redirect policy is invalid");
  }
  return {
    ...(value.follow === undefined ? {} : { follow: value.follow }),
    ...(value.maxRedirects === undefined
      ? {}
      : { maxRedirects: value.maxRedirects }),
  };
}

/** Requires both user-default fields while applying the fixed hard ceiling. */
export function validateResolvedRedirectPolicy(
  value: ResolvedRedirectPolicy,
): ResolvedRedirectPolicy {
  const parsed = validateRedirectPolicyOverride(value);
  if (parsed.follow === undefined || parsed.maxRedirects === undefined) {
    throw new Error("HTTP redirect defaults must be complete");
  }
  return { follow: parsed.follow, maxRedirects: parsed.maxRedirects };
}

/** Parses persisted override JSON without allowing damaged policy values through. */
export function parseRedirectPolicyOverride(
  value: string,
): RedirectPolicyOverride {
  return validateRedirectPolicyOverride(
    JSON.parse(value) as RedirectPolicyOverride,
  );
}

/** Resolves request, workspace, user, and packaged values field by field. */
export async function resolveRedirectPolicy(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  userId: EntityId,
  workspaceId: EntityId,
  request: RedirectPolicyOverride,
): Promise<ResolvedRedirectPolicy> {
  const [workspace, preferences] = await Promise.all([
    database
      .selectFrom("workspaces")
      .select("redirect_policy_json")
      .where("id", "=", idToBytes(workspaceId))
      .executeTakeFirstOrThrow(),
    database
      .selectFrom("user_preferences")
      .select("redirect_policy_json")
      .where("user_id", "=", idToBytes(userId))
      .executeTakeFirst(),
  ]);
  const workspacePolicy = parseRedirectPolicyOverride(
    workspace.redirect_policy_json,
  );
  const userPolicy =
    preferences === undefined
      ? DEFAULT_REDIRECT_POLICY
      : validateResolvedRedirectPolicy(
          JSON.parse(
            preferences.redirect_policy_json,
          ) as ResolvedRedirectPolicy,
        );
  return {
    follow: request.follow ?? workspacePolicy.follow ?? userPolicy.follow,
    maxRedirects:
      request.maxRedirects ??
      workspacePolicy.maxRedirects ??
      userPolicy.maxRedirects,
  };
}

/** Owns optimistic server-backed execution defaults for application users. */
export class UserPreferencesService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #audit: AuditService;

  constructor(database: Kysely<DatabaseSchema>, audit: AuditService) {
    this.#database = database;
    this.#audit = audit;
  }

  /** Loads stored defaults or the packaged defaults for a new user. */
  async get(userId: EntityId): Promise<UserPreferencesView> {
    const row = await this.#database
      .selectFrom("user_preferences")
      .select([
        "revision",
        "redirect_policy_json",
        "cookie_policy_json",
        "cookie_concurrency_mode",
      ])
      .where("user_id", "=", idToBytes(userId))
      .executeTakeFirst();
    return row === undefined
      ? {
          redirectPolicy: DEFAULT_REDIRECT_POLICY,
          cookiePolicy: DEFAULT_COOKIE_POLICY,
          cookieConcurrencyMode: DEFAULT_COOKIE_CONCURRENCY_MODE,
          revision: 0,
        }
      : {
          redirectPolicy: validateResolvedRedirectPolicy(
            JSON.parse(row.redirect_policy_json) as ResolvedRedirectPolicy,
          ),
          cookiePolicy: validateResolvedCookiePolicy(
            JSON.parse(row.cookie_policy_json) as ResolvedCookiePolicy,
          ),
          cookieConcurrencyMode: validateCookieConcurrencyMode(
            row.cookie_concurrency_mode,
          ),
          revision: row.revision,
        };
  }

  /** Replaces user HTTP execution defaults with optimistic conflict detection. */
  async update(
    userId: EntityId,
    expectedRevision: number,
    redirectPolicy: ResolvedRedirectPolicy,
    cookiePolicy: ResolvedCookiePolicy,
    cookieConcurrencyMode: CookieConcurrencyMode,
  ): Promise<UserPreferencesView> {
    const policy = validateResolvedRedirectPolicy(redirectPolicy);
    const cookies = validateResolvedCookiePolicy(cookiePolicy);
    const concurrency = validateCookieConcurrencyMode(cookieConcurrencyMode);
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("user_preferences")
        .select([
          "revision",
          "redirect_policy_json",
          "cookie_policy_json",
          "cookie_concurrency_mode",
        ])
        .where("user_id", "=", idToBytes(userId))
        .executeTakeFirst();
      const revision = row?.revision ?? 0;
      if (revision !== expectedRevision) {
        throw new UserPreferencesConflictError("User preferences changed");
      }
      const json = JSON.stringify(policy);
      const cookieJson = JSON.stringify(cookies);
      if (
        row !== undefined &&
        row.redirect_policy_json === json &&
        row.cookie_policy_json === cookieJson &&
        row.cookie_concurrency_mode === concurrency
      ) {
        return {
          redirectPolicy: policy,
          cookiePolicy: cookies,
          cookieConcurrencyMode: concurrency,
          revision,
        };
      }
      const nextRevision = revision + 1;
      if (row === undefined) {
        await transaction
          .insertInto("user_preferences")
          .values({
            user_id: idToBytes(userId),
            revision: nextRevision,
            redirect_policy_json: json,
            cookie_policy_json: cookieJson,
            cookie_concurrency_mode: concurrency,
          })
          .execute();
      } else {
        const result = await transaction
          .updateTable("user_preferences")
          .set({
            revision: nextRevision,
            redirect_policy_json: json,
            cookie_policy_json: cookieJson,
            cookie_concurrency_mode: concurrency,
          })
          .where("user_id", "=", idToBytes(userId))
          .where("revision", "=", expectedRevision)
          .executeTakeFirst();
        if (result.numUpdatedRows !== 1n) {
          throw new UserPreferencesConflictError("User preferences changed");
        }
      }
      await this.#audit.record(transaction, {
        type: "user_preferences.updated",
        actorUserId: userId,
        workspaceId: null,
        data: { revision: nextRevision },
      });
      return {
        redirectPolicy: policy,
        cookiePolicy: cookies,
        cookieConcurrencyMode: concurrency,
        revision: nextRevision,
      };
    });
  }
}
