import { readonly, ref, type DeepReadonly, type Ref } from "vue";

import type { RequestField } from "@/model/contracts/backend";

export type HeaderMergeMode = NonNullable<RequestField["mode"]>;

const STORAGE_KEY = "apinteract.appendingHeaders";
const DEFAULT_APPENDING_HEADERS = ["Cookie"] as const;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const appendingHeaderNames = ref<readonly string[]>(readPreference());

/** Separates canonical defaults from invalid option input. */
export interface ParsedHeaderNames {
  readonly names: readonly string[];
  readonly invalidNames: readonly string[];
}

/** Provides reactive application-wide header authoring defaults. */
export interface HeaderPreferences {
  readonly appendingHeaderNames: DeepReadonly<Ref<readonly string[]>>;
  readonly setAppendingHeaderNames: (names: readonly string[]) => void;
}

/** Exposes application-wide defaults used when authors name new header rows. */
export function useHeaderPreferences(): HeaderPreferences {
  return {
    appendingHeaderNames: readonly(appendingHeaderNames),
    setAppendingHeaderNames,
  };
}

/** Selects the configured default merge mode for one newly named header. */
export function defaultHeaderMergeMode(name: string): HeaderMergeMode {
  const normalizedName = name.trim().toLowerCase();
  return appendingHeaderNames.value.some(
    (candidate) => candidate.toLowerCase() === normalizedName,
  )
    ? "append"
    : "override";
}

/** Parses comma- or line-separated header names without accepting invalid names. */
export function parseAppendingHeaderNames(value: string): ParsedHeaderNames {
  const names: string[] = [];
  const invalidNames: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value.split(/[\n,]/u)) {
    const name = candidate.trim();
    if (name === "") continue;
    if (!HEADER_NAME_PATTERN.test(name)) {
      invalidNames.push(name);
      continue;
    }
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return { names, invalidNames };
}

/** Replaces and persists the defaults shared by every header editor. */
function setAppendingHeaderNames(names: readonly string[]): void {
  const parsed = parseAppendingHeaderNames(names.join("\n"));
  if (parsed.invalidNames.length > 0) {
    throw new Error("Appending header names are invalid");
  }
  appendingHeaderNames.value = parsed.names;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed.names));
  } catch {
    // Browser storage can be disabled; the in-memory preference remains useful.
  }
}

/** Restores a validated preference while tolerating unavailable browser storage. */
function readPreference(): readonly string[] {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null) return DEFAULT_APPENDING_HEADERS;
    const parsed: unknown = JSON.parse(stored);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((name) => typeof name === "string")
    ) {
      return DEFAULT_APPENDING_HEADERS;
    }
    const normalized = parseAppendingHeaderNames(parsed.join("\n"));
    return normalized.invalidNames.length === 0
      ? normalized.names
      : DEFAULT_APPENDING_HEADERS;
  } catch {
    return DEFAULT_APPENDING_HEADERS;
  }
}
