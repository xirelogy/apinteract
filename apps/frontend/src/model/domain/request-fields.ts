import type { RequestField } from "@/model/contracts/backend";

/** Creates the presentation-only row used to begin a new structured field. */
export function createBlankRequestField(): RequestField {
  return { name: "", value: "", enabled: true };
}

/** Creates a blank header whose inheritance mode remains explicit on save. */
export function createBlankHeaderField(): RequestField {
  return { name: "", value: "", enabled: true, mode: "override" };
}

/** Reports whether a structured field contains no wire or documentation content. */
export function isBlankRequestField(field: RequestField): boolean {
  return (
    field.name === "" && field.value === "" && (field.description ?? "") === ""
  );
}

/** Copies fields and appends one editable trailing row when none exists. */
export function editableRequestFields(
  fields: readonly RequestField[],
  includeBlank: boolean,
  createBlank: () => RequestField = createBlankRequestField,
): RequestField[] {
  const editable = fields.map((field) => ({ ...field }));
  if (
    includeBlank &&
    (editable.length === 0 ||
      !isBlankRequestField(editable[editable.length - 1]!))
  ) {
    editable.push(createBlank());
  }
  return editable;
}

/** Appends the next blank row after the current trailing row becomes meaningful. */
export function ensureTrailingBlankRequestField(
  fields: RequestField[],
  createBlank: () => RequestField = createBlankRequestField,
): void {
  if (fields.length === 0 || !isBlankRequestField(fields[fields.length - 1]!)) {
    fields.push(createBlank());
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
