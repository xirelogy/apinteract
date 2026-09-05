import type { AuthProviderValue } from "@apinteract/plugin-api/backend/authentication";

const MAX_DEPTH = 8;
const MAX_ITEMS = 256;
const MAX_KEY_LENGTH = 100;
const MAX_STRING_LENGTH = 4096;
const MAX_SERIALIZED_LENGTH = 32_768;

/** Validates bounded, recursively JSON-compatible data returned by a provider. */
export function validateProviderValue(
  value: unknown,
  location: string,
): asserts value is AuthProviderValue {
  const state = { items: 0 };
  visitProviderValue(value, location, 0, state);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length > MAX_SERIALIZED_LENGTH) {
    throw new Error(`${location} is invalid or too large`);
  }
}

/** Validates provider data whose public contract specifically requires an object. */
export function validateProviderObject(
  value: unknown,
  location: string,
): asserts value is Readonly<Record<string, AuthProviderValue>> {
  if (!isRecord(value)) throw new Error(`${location} must be an object`);
  validateProviderValue(value, location);
}

/** Walks one provider value while bounding its shape before serialization. */
function visitProviderValue(
  value: unknown,
  location: string,
  depth: number,
  state: { items: number },
): void {
  state.items += 1;
  if (depth > MAX_DEPTH || state.items > MAX_ITEMS) {
    throw new Error(
      `${location} is too deeply nested or contains too many items`,
    );
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${location} is invalid`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      throw new Error(`${location} contains an overlong string`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      visitProviderValue(item, `${location}[${index}]`, depth + 1, state),
    );
    return;
  }
  if (!isRecord(value)) throw new Error(`${location} is not JSON-compatible`);
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
      throw new Error(`${location} contains an invalid property name`);
    }
    visitProviderValue(item, `${location}.${key}`, depth + 1, state);
  }
}

/** Accepts only plain records so class instances cannot cross the plugin boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
