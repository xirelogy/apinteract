import type { PluginLabel } from "@apinteract/plugin-api/frontend";

interface LocaleProfile {
  readonly language: string;
  readonly script: string;
  readonly region: string;
}

const canonicalLocaleCache = new Map<string, string | null>();
const localeProfileCache = new Map<string, LocaleProfile | null>();
const translationLocaleCache = new WeakMap<
  Readonly<Record<string, string>>,
  Map<string, string>
>();
const translationResolutionCache = new WeakMap<
  Readonly<Record<string, string>>,
  Map<string, string | null>
>();
const localeSetResolutionCache = new Map<string, Map<string, string | null>>();
/** Keeps established English regional conventions deterministic when both variants exist. */
const regionalFallbacks: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  en: {
    au: "gb",
    ca: "us",
    ie: "gb",
    nz: "gb",
  },
};

/** Canonicalizes one BCP 47 tag once and remembers invalid inputs safely. */
function canonicalLocale(locale: string): string | null {
  const cached = canonicalLocaleCache.get(locale);
  if (cached !== undefined || canonicalLocaleCache.has(locale)) {
    return cached ?? null;
  }
  let canonical: string | null = null;
  try {
    canonical = Intl.getCanonicalLocales(locale)[0] ?? null;
  } catch {
    canonical = null;
  }
  canonicalLocaleCache.set(locale, canonical);
  return canonical;
}

/** Expands one canonical tag using the runtime's CLDR likely-subtag data. */
function localeProfile(locale: string): LocaleProfile | null {
  const cached = localeProfileCache.get(locale);
  if (cached !== undefined || localeProfileCache.has(locale)) {
    return cached ?? null;
  }
  let profile: LocaleProfile | null = null;
  try {
    const maximized = new Intl.Locale(locale).maximize();
    profile = {
      language: maximized.language.toLowerCase(),
      script: (maximized.script ?? "").toLowerCase(),
      region: (maximized.region ?? "").toLowerCase(),
    };
  } catch {
    profile = null;
  }
  localeProfileCache.set(locale, profile);
  return profile;
}

/** Scores a candidate after language, script, and likely region comparison. */
function localeScore(requested: string, candidate: string): number | null {
  if (requested.toLowerCase() === candidate.toLowerCase()) return 0;
  const requestedProfile = localeProfile(requested);
  const candidateProfile = localeProfile(candidate);
  if (
    requestedProfile === null ||
    candidateProfile === null ||
    requestedProfile.language !== candidateProfile.language ||
    requestedProfile.script !== candidateProfile.script
  ) {
    return null;
  }
  if (requestedProfile.region === candidateProfile.region) return 1;
  const preferredRegion =
    regionalFallbacks[requestedProfile.language]?.[requestedProfile.region];
  return preferredRegion === candidateProfile.region ? 2 : 3;
}

/** Finds the best available translation locale without crossing script families. */
function bestTranslationLocale(
  translations: Readonly<Record<string, string>>,
  locale: string,
): string | null {
  const requested = canonicalLocale(locale);
  if (requested === null) return null;
  let best: { key: string; score: number; order: number } | null = null;
  for (const [order, key] of Object.keys(translations).entries()) {
    const candidate = canonicalLocale(key);
    if (candidate === null) continue;
    const score = localeScore(requested, candidate);
    if (
      score !== null &&
      (best === null ||
        score < best.score ||
        (score === best.score && order < best.order))
    ) {
      best = { key, score, order };
    }
  }
  return best?.key ?? null;
}

/** Selects the closest available locale without crossing language scripts. */
export function matchLocale(
  requestedLocale: string,
  availableLocales: readonly string[],
): string | null {
  const setKey = availableLocales.join("\u0000");
  let cache = localeSetResolutionCache.get(setKey);
  if (cache === undefined) {
    cache = new Map();
    localeSetResolutionCache.set(setKey, cache);
    if (localeSetResolutionCache.size > 64) {
      const oldest = localeSetResolutionCache.keys().next().value;
      if (oldest !== undefined) localeSetResolutionCache.delete(oldest);
    }
  }
  const cacheKey = requestedLocale;
  const cached = cache.get(cacheKey);
  if (cached !== undefined || cache.has(cacheKey)) return cached ?? null;
  const translations = Object.fromEntries(
    availableLocales.map((locale) => [locale, locale]),
  );
  const match = bestTranslationLocale(translations, requestedLocale);
  cache.set(cacheKey, match);
  return match;
}

/** Indexes canonical translation keys once for one immutable translation map. */
function translationKeys(
  translations: Readonly<Record<string, string>>,
): Map<string, string> {
  const cached = translationLocaleCache.get(translations);
  if (cached !== undefined) return cached;
  const index = new Map<string, string>();
  for (const key of Object.keys(translations)) {
    const canonical = canonicalLocale(key);
    if (canonical !== null && !index.has(canonical.toLowerCase())) {
      index.set(canonical.toLowerCase(), key);
    }
  }
  translationLocaleCache.set(translations, index);
  return index;
}

/** Resolves package-owned text using cached CLDR-aware locale matching. */
export function localize(
  fallback: string,
  translations: Readonly<Record<string, string>>,
  locale: string,
): string {
  const direct = translations[locale];
  if (direct !== undefined) return direct;
  const canonical = canonicalLocale(locale);
  if (canonical !== null) {
    const canonicalKey = translationKeys(translations).get(
      canonical.toLowerCase(),
    );
    if (canonicalKey !== undefined) return translations[canonicalKey]!;
  }
  if (Object.keys(translations).length === 0) return fallback;
  let cache = translationResolutionCache.get(translations);
  if (cache === undefined) {
    cache = new Map();
    translationResolutionCache.set(translations, cache);
  }
  const cacheKey = canonical ?? locale;
  const cached = cache.get(cacheKey);
  if (cached !== undefined || cache.has(cacheKey)) {
    return cached === null || cached === undefined
      ? fallback
      : (translations[cached] ?? fallback);
  }
  const key = bestTranslationLocale(translations, locale);
  cache.set(cacheKey, key);
  return key === null ? fallback : (translations[key] ?? fallback);
}

/** Resolves a plugin contribution label with its declared default fallback. */
export function localizePluginLabel(
  label: PluginLabel,
  locale: string,
): string {
  return localize(label.default, label.translations ?? {}, locale);
}
