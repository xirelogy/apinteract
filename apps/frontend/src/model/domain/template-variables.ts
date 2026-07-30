/**
 * Parses request template placeholders for editor decoration only.
 * Authoritative resolution remains backend-owned and execution-time validated.
 */

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;

export type TemplateSegment =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "variable";
      readonly text: string;
      readonly name: string;
      readonly valid: boolean;
      readonly start: number;
      readonly end: number;
    };

/** Splits source text while preserving exact placeholder and escape spelling. */
export function parseTemplateSegments(source: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const opening = source.indexOf("<<", cursor);
    if (opening < 0) {
      segments.push({
        kind: "text",
        text: source.slice(cursor),
        start: cursor,
        end: source.length,
      });
      break;
    }
    if (opening > cursor) {
      segments.push({
        kind: "text",
        text: source.slice(cursor, opening),
        start: cursor,
        end: opening,
      });
    }
    if (source.startsWith("<<<<", opening)) {
      segments.push({
        kind: "text",
        text: "<<<<",
        start: opening,
        end: opening + 4,
      });
      cursor = opening + 4;
      continue;
    }
    const closing = source.indexOf(">>", opening + 2);
    if (closing < 0) {
      segments.push({
        kind: "text",
        text: source.slice(opening),
        start: opening,
        end: source.length,
      });
      break;
    }
    const end = closing + 2;
    const name = source.slice(opening + 2, closing);
    segments.push({
      kind: "variable",
      text: source.slice(opening, end),
      name,
      valid: VARIABLE_NAME.test(name),
      start: opening,
      end,
    });
    cursor = end;
  }
  return segments;
}

/** Returns unique valid names in first-reference order across template fields. */
export function collectTemplateVariableNames(
  sources: readonly string[],
): string[] {
  const names = new Set<string>();
  for (const source of sources) {
    for (const segment of parseTemplateSegments(source)) {
      if (segment.kind === "variable" && segment.valid) {
        names.add(segment.name);
      }
    }
  }
  return [...names];
}
