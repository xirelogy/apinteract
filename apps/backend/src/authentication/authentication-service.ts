import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  AuthProviderAttemptState,
  AuthProviderFlowResult,
  AuthProviderInput,
  AuthProviderValue,
} from "@apinteract/plugin-api/backend/authentication";
import type { Kysely } from "kysely";

import { createEntityId, idToBytes, type EntityId } from "../foundation/id.js";
import type {
  ApplicationUser,
  IdentityService,
} from "../identity/identity-service.js";
import type { DatabaseSchema } from "../persistence/schema.js";
import type { AuthProviderRegistry } from "./auth-provider-registry.js";
import { validateProviderValue } from "./provider-value.js";

const ATTEMPT_LIFETIME_MS = 5 * 60 * 1000;
const MAX_ATTEMPT_TRANSITIONS = 8;
const MAX_INPUT_FIELDS = 32;
const MAX_INPUT_LENGTH = 4096;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_ATTEMPTS = 10;

export class AuthenticationRateLimitError extends Error {}
export class AuthenticationInputError extends Error {}

/** Internal result consumed by the HTTP session boundary. */
export type AuthenticationTransition =
  | {
      readonly status: "interaction_required";
      readonly attemptId: EntityId;
      readonly binding: string;
      readonly publicData: AuthProviderValue;
    }
  | { readonly status: "authenticated"; readonly user: ApplicationUser }
  | { readonly status: "rejected" }
  | { readonly status: "unavailable"; readonly retryable: boolean };

/** Orchestrates provider-independent attempts and core identity resolution. */
export class AuthenticationService {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #providers: AuthProviderRegistry;
  readonly #identity: IdentityService;
  readonly #rateLimits = new Map<string, { count: number; resetsAt: number }>();

  constructor(
    database: Kysely<DatabaseSchema>,
    providers: AuthProviderRegistry,
    identity: IdentityService,
  ) {
    this.#database = database;
    this.#providers = providers;
    this.#identity = identity;
  }

  /** Starts one configured provider flow with bounded evidence. */
  async begin(
    providerInstanceId: string,
    input: AuthProviderInput,
    rateLimitKey = "unspecified",
  ): Promise<AuthenticationTransition> {
    await this.#purgeExpiredAttempts();
    validateInput(input);
    const provider = this.#providers.require(providerInstanceId);
    const limiterKey = `${providerInstanceId}:${rateLimitKey}`;
    this.#consumeRateLimit(limiterKey);
    const transition = await this.#processResult(
      providerInstanceId,
      await provider.runtime.begin(input),
    );
    if (
      transition.status === "authenticated" ||
      transition.status === "unavailable"
    ) {
      this.#releaseRateLimit(limiterKey);
    }
    return transition;
  }

  /** Applies a bounded core-owned attempt rate without involving providers. */
  #consumeRateLimit(key: string): void {
    const now = Date.now();
    if (this.#rateLimits.size > 10_000) {
      for (const [candidate, limit] of this.#rateLimits) {
        if (limit.resetsAt <= now) this.#rateLimits.delete(candidate);
      }
    }
    const current = this.#rateLimits.get(key);
    if (current === undefined || current.resetsAt <= now) {
      if (current === undefined && this.#rateLimits.size >= 10_000) {
        throw new AuthenticationRateLimitError(
          "Authentication rate-limit capacity exceeded",
        );
      }
      this.#rateLimits.set(key, {
        count: 1,
        resetsAt: now + RATE_LIMIT_WINDOW_MS,
      });
      return;
    }
    if (current.count >= RATE_LIMIT_ATTEMPTS) {
      throw new AuthenticationRateLimitError(
        "Authentication rate limit exceeded",
      );
    }
    current.count += 1;
  }

  /** Releases the provisional slot for successful or non-failing attempts. */
  #releaseRateLimit(key: string): void {
    const current = this.#rateLimits.get(key);
    if (current === undefined) return;
    if (current.count <= 1) this.#rateLimits.delete(key);
    else current.count -= 1;
  }

  /** Advances one bound attempt exactly once for each stored transition. */
  async continue(
    attemptId: EntityId,
    binding: string,
    input: AuthProviderInput,
    rateLimitKey = "unspecified",
  ): Promise<AuthenticationTransition> {
    validateInput(input);
    const now = Date.now();
    const row = await this.#database
      .selectFrom("authentication_attempts")
      .selectAll()
      .where("id", "=", idToBytes(attemptId))
      .executeTakeFirst();
    if (
      row === undefined ||
      !sameHash(row.binding_hash, hashBinding(binding))
    ) {
      return { status: "rejected" };
    }
    if (
      row.status !== "active" ||
      row.expires_at <= now ||
      row.transition_count >= MAX_ATTEMPT_TRANSITIONS
    ) {
      if (row.status === "active") await this.#discardAttempt(attemptId);
      return { status: "rejected" };
    }
    const limiterKey = `${row.provider_instance_id}:${rateLimitKey}`;
    this.#consumeRateLimit(limiterKey);
    const claimed = await this.#database
      .updateTable("authentication_attempts")
      .set({ status: "consumed" })
      .where("id", "=", idToBytes(attemptId))
      .where("status", "=", "active")
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) !== 1) return { status: "rejected" };
    const provider = this.#providers.require(row.provider_instance_id);
    if (provider.runtime.continue === undefined) {
      await this.#discardAttempt(attemptId);
      return { status: "rejected" };
    }
    try {
      const result = await provider.runtime.continue(
        parseAttemptState(row.state_json),
        input,
      );
      const transition = await this.#processResult(
        row.provider_instance_id,
        result,
        attemptId,
        binding,
        row.transition_count + 1,
      );
      if (
        transition.status === "authenticated" ||
        transition.status === "unavailable"
      ) {
        this.#releaseRateLimit(limiterKey);
      }
      return transition;
    } catch (cause) {
      await this.#discardAttempt(attemptId);
      throw cause;
    }
  }

  /** Cancels one bound attempt without revealing whether it previously existed. */
  async cancel(attemptId: EntityId, binding: string): Promise<void> {
    const row = await this.#database
      .selectFrom("authentication_attempts")
      .selectAll()
      .where("id", "=", idToBytes(attemptId))
      .where("status", "=", "active")
      .executeTakeFirst();
    if (
      row === undefined ||
      !sameHash(row.binding_hash, hashBinding(binding))
    ) {
      return;
    }
    const claimed = await this.#database
      .updateTable("authentication_attempts")
      .set({ status: "cancelled" })
      .where("id", "=", idToBytes(attemptId))
      .where("status", "=", "active")
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) !== 1) return;
    try {
      await this.#providers
        .require(row.provider_instance_id)
        .runtime.cancel?.(parseAttemptState(row.state_json));
    } finally {
      await this.#discardAttempt(attemptId);
    }
  }

  /** Validates provider output before retaining state or resolving core identity. */
  async #processResult(
    providerInstanceId: string,
    result: AuthProviderFlowResult,
    existingAttemptId?: EntityId,
    existingBinding?: string,
    transitionCount = 0,
  ): Promise<AuthenticationTransition> {
    validateFlowResult(result);
    if (result.status === "rejected") {
      if (existingAttemptId !== undefined) {
        await this.#discardAttempt(existingAttemptId);
      }
      return { status: "rejected" };
    }
    if (result.status === "unavailable") {
      if (existingAttemptId !== undefined) {
        await this.#discardAttempt(existingAttemptId);
      }
      return { status: "unavailable", retryable: result.retryable };
    }
    if (result.status === "authenticated") {
      validateAssertion(providerInstanceId, result, Date.now());
      try {
        return {
          status: "authenticated",
          user: await this.#identity.resolveAssertion(result.assertion),
        };
      } finally {
        if (existingAttemptId !== undefined) {
          await this.#discardAttempt(existingAttemptId);
        }
      }
    }
    validateAttemptState(result.state);
    validateProviderValue(result.publicData, "authentication public data");
    const attemptId = existingAttemptId ?? createEntityId();
    const binding = existingBinding ?? randomBytes(32).toString("base64url");
    if (existingAttemptId === undefined) {
      const now = Date.now();
      await this.#database
        .insertInto("authentication_attempts")
        .values({
          id: idToBytes(attemptId),
          provider_instance_id: providerInstanceId,
          state_json: JSON.stringify(result.state),
          binding_hash: hashBinding(binding),
          status: "active",
          transition_count: transitionCount,
          created_at: now,
          expires_at: now + ATTEMPT_LIFETIME_MS,
        })
        .execute();
    } else {
      const updated = await this.#database
        .updateTable("authentication_attempts")
        .set({
          state_json: JSON.stringify(result.state),
          status: "active",
          transition_count: transitionCount,
        })
        .where("id", "=", idToBytes(attemptId))
        .where("status", "=", "consumed")
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) {
        return { status: "rejected" };
      }
    }
    return {
      status: "interaction_required",
      attemptId,
      binding,
      publicData: result.publicData,
    };
  }

  /** Deletes terminal provider state as soon as the browser can no longer use it. */
  async #discardAttempt(attemptId: EntityId): Promise<void> {
    await this.#database
      .deleteFrom("authentication_attempts")
      .where("id", "=", idToBytes(attemptId))
      .execute();
  }

  /** Removes expired provider state opportunistically before accepting new work. */
  async #purgeExpiredAttempts(): Promise<void> {
    const now = Date.now();
    await this.#database
      .deleteFrom("authentication_attempts")
      .where("status", "=", "active")
      .where("expires_at", "<=", now)
      .execute();
    await this.#database
      .deleteFrom("authentication_attempts")
      .where("status", "!=", "active")
      .where("expires_at", "<=", now - ATTEMPT_LIFETIME_MS)
      .execute();
  }
}

/** Applies common evidence field and size limits before provider execution. */
function validateInput(input: AuthProviderInput): void {
  const entries = Object.entries(input);
  if (
    entries.length > MAX_INPUT_FIELDS ||
    entries.some(
      ([key, value]) =>
        key.length === 0 ||
        key.length > 100 ||
        typeof value !== "string" ||
        value.length > MAX_INPUT_LENGTH,
    )
  ) {
    throw new AuthenticationInputError("Authentication input is invalid");
  }
}

/** Rejects malformed state before writing provider-controlled JSON. */
function validateAttemptState(state: AuthProviderAttemptState): void {
  if (
    !isRecord(state) ||
    !Number.isSafeInteger(state.schemaVersion) ||
    state.schemaVersion < 1 ||
    !("data" in state)
  ) {
    throw new Error("Authentication provider returned invalid attempt state");
  }
  validateProviderValue(state.data, "authentication attempt state");
  const serialized = JSON.stringify(state);
  if (serialized.length > 32_768) {
    throw new Error("Authentication provider attempt state is too large");
  }
}

/** Parses state previously accepted at the provider boundary. */
function parseAttemptState(value: string): AuthProviderAttemptState {
  return JSON.parse(value) as AuthProviderAttemptState;
}

/** Requires assertions to remain scoped, current, and meaningfully attributed. */
function validateAssertion(
  providerInstanceId: string,
  result: Extract<AuthProviderFlowResult, { readonly status: "authenticated" }>,
  now: number,
): void {
  const assertion = result.assertion;
  if (
    !isRecord(assertion) ||
    assertion.providerInstanceId !== providerInstanceId ||
    typeof assertion.subject !== "string" ||
    assertion.subject.length === 0 ||
    assertion.subject.length > 500 ||
    !Array.isArray(assertion.authenticationMethods) ||
    assertion.authenticationMethods.length === 0 ||
    assertion.authenticationMethods.length > 16 ||
    assertion.authenticationMethods.some(
      (method) =>
        typeof method !== "string" ||
        method.length === 0 ||
        method.length > 100,
    ) ||
    new Set(assertion.authenticationMethods).size !==
      assertion.authenticationMethods.length ||
    typeof assertion.authenticatedAt !== "number" ||
    !Number.isFinite(assertion.authenticatedAt) ||
    assertion.authenticatedAt < now - ATTEMPT_LIFETIME_MS ||
    assertion.authenticatedAt > now + 30_000 ||
    !validSafeProfileClaims(assertion.safeProfileClaims)
  ) {
    throw new Error("Authentication provider returned an invalid assertion");
  }
}

/** Bounds optional non-authoritative profile claims returned with an assertion. */
function validSafeProfileClaims(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 32 &&
    entries.every(
      ([key, claim]) =>
        key.length > 0 &&
        key.length <= 100 &&
        typeof claim === "string" &&
        claim.length <= 1000,
    )
  );
}

/** Validates the runtime shape and terminal metadata of one plugin result. */
function validateFlowResult(result: AuthProviderFlowResult): void {
  if (!isRecord(result) || typeof result.status !== "string") {
    throw new Error("Authentication provider returned an invalid result");
  }
  if (
    (result.status === "rejected" || result.status === "unavailable") &&
    (typeof result.internalCode !== "string" ||
      result.internalCode.length === 0 ||
      result.internalCode.length > 200)
  ) {
    throw new Error("Authentication provider returned an invalid result");
  }
  if (
    result.status === "unavailable" &&
    typeof result.retryable !== "boolean"
  ) {
    throw new Error("Authentication provider returned an invalid result");
  }
  if (
    result.status !== "interaction_required" &&
    result.status !== "authenticated" &&
    result.status !== "rejected" &&
    result.status !== "unavailable"
  ) {
    throw new Error("Authentication provider returned an invalid result");
  }
}

/** Narrows an untrusted plugin result to an own-property object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hashes the browser-only binding secret before persistence. */
function hashBinding(binding: string): string {
  return createHash("sha256").update(binding).digest("hex");
}

/** Compares fixed-length hexadecimal hashes without content-dependent timing. */
function sameHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
