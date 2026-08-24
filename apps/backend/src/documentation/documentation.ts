/** Maximum UTF-8 bytes accepted for one short resource description. */
export const RESOURCE_DESCRIPTION_MAX_BYTES = 2 * 1024;

/** Maximum UTF-8 bytes accepted for one field or variable description. */
export const FIELD_DESCRIPTION_MAX_BYTES = 4 * 1024;

/** Maximum UTF-8 bytes accepted for one CommonMark notes document. */
export const RESOURCE_NOTES_MAX_BYTES = 256 * 1024;

/** Identifies invalid documentation input without exposing its content. */
export class DocumentationValidationError extends Error {}

/** Validates and preserves one single-line resource description. */
export function validateResourceDescription(value: string): string {
  validateBoundedText(value, RESOURCE_DESCRIPTION_MAX_BYTES, "Description");
  if (/\r|\n/u.test(value)) {
    throw new DocumentationValidationError("Description must be a single line");
  }
  return value;
}

/** Validates and preserves one field or variable description. */
export function validateFieldDescription(value: string | undefined): string {
  const normalized = value ?? "";
  validateBoundedText(
    normalized,
    FIELD_DESCRIPTION_MAX_BYTES,
    "Field description",
  );
  return normalized;
}

/** Validates and preserves CommonMark source without rendering it. */
export function validateResourceNotes(value: string): string {
  validateBoundedText(value, RESOURCE_NOTES_MAX_BYTES, "Notes");
  return value;
}

/** Enforces a UTF-8 byte limit at backend trust and persistence boundaries. */
function validateBoundedText(
  value: string,
  maximum: number,
  name: string,
): void {
  if (typeof value !== "string") {
    throw new DocumentationValidationError(`${name} must be a string`);
  }
  if (Buffer.byteLength(value, "utf8") > maximum) {
    throw new DocumentationValidationError(`${name} is too large`);
  }
}
