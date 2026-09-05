import type {
  AuthProviderConfigurationSchema,
  AuthProviderValue,
} from "@apinteract/plugin-api/backend/authentication";

/** Validates one bounded provider configuration against the published subset. */
export function validateAuthProviderConfiguration(
  schema: AuthProviderConfigurationSchema,
  value: AuthProviderValue,
  location = "configuration",
): void {
  if (schema.type === "object") {
    if (!isObject(value)) fail(location, "must be an object");
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in value)) fail(`${location}.${required}`, "is required");
    }
    for (const [key, item] of Object.entries(value)) {
      const itemSchema = properties[key];
      if (itemSchema === undefined) {
        if (schema.additionalProperties !== true) {
          fail(`${location}.${key}`, "is not supported");
        }
      } else {
        validateAuthProviderConfiguration(
          itemSchema,
          item,
          `${location}.${key}`,
        );
      }
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) fail(location, "must be an array");
    const items = value as readonly AuthProviderValue[];
    if (schema.minItems !== undefined && items.length < schema.minItems) {
      fail(location, "contains too few items");
    }
    if (schema.maxItems !== undefined && items.length > schema.maxItems) {
      fail(location, "contains too many items");
    }
    items.forEach((item, index) =>
      validateAuthProviderConfiguration(
        schema.items,
        item,
        `${location}[${index}]`,
      ),
    );
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") fail(location, "must be a string");
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(location, "is too short");
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      fail(location, "is too long");
    }
    if (
      schema.pattern !== undefined &&
      !new RegExp(schema.pattern, "u").test(value)
    ) {
      fail(location, "has an invalid format");
    }
    return;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") fail(location, "must be a boolean");
    return;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (schema.type === "integer" && !Number.isSafeInteger(value))
  ) {
    fail(
      location,
      `must be ${schema.type === "integer" ? "an integer" : "a number"}`,
    );
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    fail(location, "is below the minimum");
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    fail(location, "is above the maximum");
  }
}

/** Narrows a JSON value to its object representation. */
function isObject(
  value: AuthProviderValue,
): value is { readonly [key: string]: AuthProviderValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throws one location-aware secret-free configuration diagnostic. */
function fail(location: string, detail: string): never {
  throw new Error(`${location} ${detail}`);
}
