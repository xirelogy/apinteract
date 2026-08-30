import type { ImportSource } from "@apinteract/plugin-api/backend";

/** Represents an import-provider failure that the host may safely expose. */
export class ImportProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Reports whether an unknown JSON value is a non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows an unknown JSON array without exposing an any-valued result. */
export function unknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** Parses one JSON import source and requires an object document root. */
export function parseJsonObject(source: ImportSource): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source.text);
  } catch {
    throw new ImportProviderError(
      "import_json_invalid",
      `${source.name} does not contain valid JSON.`,
    );
  }
  if (!isRecord(value)) {
    throw new ImportProviderError(
      "import_json_invalid",
      `${source.name} must contain a JSON object.`,
    );
  }
  return value;
}

/** Reads a string value or returns the supplied fallback. */
export function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Converts a JSON-compatible example into one editable text value. */
export function editableValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** Derives a bounded display name after removing one declared extension. */
export function sourceStem(
  name: string,
  extensions: readonly string[],
): string {
  const withoutPath = name.split(/[\\/]/).at(-1) ?? name;
  const extension = extensions.find((candidate) =>
    withoutPath.toLowerCase().endsWith(candidate.toLowerCase()),
  );
  const stem = (
    extension === undefined
      ? withoutPath
      : withoutPath.slice(0, -extension.length)
  ).trim();
  return (stem || "Imported requests").slice(0, 200);
}

/** Returns the UTF-8 byte length of one imported text value. */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Returns an ISO timestamp only when the source contains a valid instant. */
export function optionalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
