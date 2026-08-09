import type { RequestField } from "@/model/contracts/backend";

/** Creates the presentation-only row used to begin a new structured field. */
export function createBlankRequestField(): RequestField {
  return { name: "", value: "", enabled: true };
}

/** Reports whether a structured field contains no user-authored wire content. */
export function isBlankRequestField(field: RequestField): boolean {
  return field.name === "" && field.value === "";
}

/** Copies fields and appends one editable trailing row when none exists. */
export function editableRequestFields(
  fields: readonly RequestField[],
  includeBlank: boolean,
): RequestField[] {
  const editable = fields.map((field) => ({ ...field }));
  if (
    includeBlank &&
    (editable.length === 0 ||
      !isBlankRequestField(editable[editable.length - 1]!))
  ) {
    editable.push(createBlankRequestField());
  }
  return editable;
}

/** Appends the next blank row after the current trailing row becomes meaningful. */
export function ensureTrailingBlankRequestField(fields: RequestField[]): void {
  if (fields.length === 0 || !isBlankRequestField(fields[fields.length - 1]!)) {
    fields.push(createBlankRequestField());
  }
}

/** Returns wire-ready copies with all untouched presentation rows omitted. */
export function meaningfulRequestFields(
  fields: readonly RequestField[],
): RequestField[] {
  return fields
    .filter((field) => !isBlankRequestField(field))
    .map((field) => ({ ...field }));
}
