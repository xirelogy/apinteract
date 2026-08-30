/** Describes one value selected through deterministic media-type matching. */
export interface MediaTypeRegistration<T> {
  readonly id: string;
  readonly patterns: readonly string[];
  readonly priority?: number;
  readonly value: T;
}

/** Identifies the registration and pattern selected for one media type. */
export interface MediaTypeMatch<T> {
  readonly id: string;
  readonly pattern: string;
  readonly specificity: number;
  readonly priority: number;
  readonly value: T;
}

interface RegisteredMediaType<T> {
  readonly id: string;
  readonly patterns: readonly ParsedMediaTypePattern[];
  readonly priority: number;
  readonly value: T;
}

interface ParsedMediaTypePattern {
  readonly source: string;
  readonly kind: "any" | "type" | "suffix" | "exact";
  readonly value: string;
  readonly specificity: number;
}

const normalizedMediaTypePattern = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
const typeWildcardPattern = /^([a-z0-9!#$&^_.+-]+)\/\*$/u;
const suffixPattern = /^\*\+([a-z0-9!#$&^_.+-]+)$/u;

/** Normalizes a declared media type without accepting malformed values. */
export function normalizeMediaType(value: string | null): string | null {
  if (value === null) return null;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalizedMediaTypePattern.test(mediaType) ? mediaType : null;
}

/** Owns conflict-checked registrations ordered by match specificity. */
export class MediaTypeRegistry<T> {
  readonly #registrations: RegisteredMediaType<T>[] = [];

  /** Registers one uniquely identified value and its supported media types. */
  register(registration: MediaTypeRegistration<T>): void {
    const id = registration.id.trim();
    if (id === "") throw new Error("Media-type registration ID is required");
    if (this.#registrations.some((candidate) => candidate.id === id)) {
      throw new Error(`Media-type registration ID is already used: ${id}`);
    }
    if (registration.patterns.length === 0) {
      throw new Error(`Media-type registration requires a pattern: ${id}`);
    }
    const priority = registration.priority ?? 0;
    if (!Number.isSafeInteger(priority)) {
      throw new Error(
        `Media-type registration priority must be an integer: ${id}`,
      );
    }
    const patterns = registration.patterns.map(parseMediaTypePattern);
    for (const pattern of patterns) {
      const conflict = this.#registrations.find(
        (candidate) =>
          candidate.priority === priority &&
          candidate.patterns.some(
            (registered) => registered.source === pattern.source,
          ),
      );
      if (conflict !== undefined) {
        throw new Error(
          `Media-type pattern ${pattern.source} conflicts between ${conflict.id} and ${id}`,
        );
      }
    }
    this.#registrations.push({
      id,
      patterns,
      priority,
      value: registration.value,
    });
  }

  /** Returns the most specific registered value for a declared media type. */
  resolve(value: string | null): T | undefined {
    return this.match(value)?.value;
  }

  /** Returns all registered values in stable installation order. */
  values(): readonly T[] {
    return this.#registrations.map((registration) => registration.value);
  }

  /** Returns matching metadata for diagnostics and precedence tests. */
  match(value: string | null): MediaTypeMatch<T> | undefined {
    const mediaType = normalizeMediaType(value);
    if (mediaType === null) return undefined;
    const matches = this.#registrations.flatMap((registration) => {
      const pattern = registration.patterns
        .filter((candidate) => mediaTypePatternMatches(candidate, mediaType))
        .sort((left, right) => right.specificity - left.specificity)[0];
      return pattern === undefined
        ? []
        : [
            {
              id: registration.id,
              pattern: pattern.source,
              specificity: pattern.specificity,
              priority: registration.priority,
              value: registration.value,
            },
          ];
    });
    matches.sort(
      (left, right) =>
        right.specificity - left.specificity || right.priority - left.priority,
    );
    const selected = matches[0];
    const ambiguous = matches[1];
    if (
      selected !== undefined &&
      ambiguous !== undefined &&
      selected.specificity === ambiguous.specificity &&
      selected.priority === ambiguous.priority
    ) {
      throw new Error(
        `Media type ${mediaType} is ambiguous between ${selected.id} and ${ambiguous.id}`,
      );
    }
    return selected;
  }
}

/** Parses one exact, suffix, type-wildcard, or universal pattern. */
function parseMediaTypePattern(source: string): ParsedMediaTypePattern {
  const pattern = source.trim().toLowerCase();
  if (pattern === "*/*") {
    return { source: pattern, kind: "any", value: "", specificity: 0 };
  }
  const typeMatch = typeWildcardPattern.exec(pattern);
  if (typeMatch?.[1] !== undefined) {
    return {
      source: pattern,
      kind: "type",
      value: typeMatch[1],
      specificity: 1,
    };
  }
  const suffixMatch = suffixPattern.exec(pattern);
  if (suffixMatch?.[1] !== undefined) {
    return {
      source: pattern,
      kind: "suffix",
      value: `+${suffixMatch[1]}`,
      specificity: 2,
    };
  }
  if (normalizedMediaTypePattern.test(pattern)) {
    return { source: pattern, kind: "exact", value: pattern, specificity: 3 };
  }
  throw new Error(`Invalid media-type pattern: ${source}`);
}

/** Reports whether a normalized media type satisfies one parsed pattern. */
function mediaTypePatternMatches(
  pattern: ParsedMediaTypePattern,
  mediaType: string,
): boolean {
  if (pattern.kind === "any") return true;
  if (pattern.kind === "exact") return mediaType === pattern.value;
  const [type, subtype] = mediaType.split("/", 2);
  return pattern.kind === "type"
    ? type === pattern.value
    : subtype?.endsWith(pattern.value) === true;
}
