import { inject, readonly, ref, type InjectionKey } from "vue";
import { createI18n } from "vue-i18n";

import { enUsMessages, type MessageSchema } from "@/app/i18n/messages";
import { officialTranslationPacks } from "@/app/i18n/official-locales";
import type {
  DeepPartialMessages,
  LocaleDirection,
  LocaleOption,
  LocalePreference,
  TranslationManifest,
  TranslationPack,
  TranslationPackDescriptor,
  TranslationService,
} from "@/app/i18n/translation-types";

export const LOCALE_PREFERENCE_KEY = "apinteract.locale";
const DEFAULT_LOCALE = "en-US";
const SYSTEM_PREFERENCE = "system";

interface ExternalTranslation {
  readonly descriptor: TranslationPackDescriptor;
  readonly url: URL;
}

export const translationServiceKey: InjectionKey<TranslationService> =
  Symbol("TranslationService");

/** Creates and initializes the application translation runtime. */
export async function createTranslationService(): Promise<TranslationService> {
  for (const pack of officialTranslationPacks) {
    validateMessages(
      pack.messages as unknown as Readonly<Record<string, unknown>>,
      enUsMessages,
    );
  }
  const officialMessages = Object.fromEntries(
    officialTranslationPacks.map((pack) => [pack.locale, pack.messages]),
  ) as Record<string, MessageSchema>;
  const i18n = createI18n<[MessageSchema], string, false>({
    legacy: false,
    locale: DEFAULT_LOCALE,
    fallbackLocale: DEFAULT_LOCALE,
    messages: officialMessages,
  });
  const locale = ref(DEFAULT_LOCALE);
  const preference = ref<LocalePreference>(readPreference());
  const externalTranslations = new Map<string, ExternalTranslation>();
  const localeOptions = ref<readonly LocaleOption[]>(
    officialTranslationPacks.map(localeOption),
  );

  await discoverExternalTranslations(externalTranslations, localeOptions);

  /** Loads and activates a locale, falling back safely when its pack fails. */
  async function activateLocale(requestedLocale: string): Promise<string> {
    const supportedLocale =
      matchSupportedLocale([requestedLocale], localeOptions.value) ??
      DEFAULT_LOCALE;
    const external = externalTranslations.get(supportedLocale);
    if (external !== undefined) {
      try {
        const pack = await loadExternalPack(external);
        const fallbackMessages =
          officialMessages[pack.fallback ?? DEFAULT_LOCALE] ?? enUsMessages;
        i18n.global.setLocaleMessage(
          supportedLocale,
          mergeMessages(fallbackMessages, pack.messages),
        );
      } catch {
        return activateLocale(DEFAULT_LOCALE);
      }
    }
    i18n.global.locale.value = supportedLocale;
    locale.value = supportedLocale;
    applyDocumentLocale(
      supportedLocale,
      localeOptions.value.find((option) => option.locale === supportedLocale)
        ?.direction ?? "ltr",
    );
    return supportedLocale;
  }

  /** Resolves and activates the current system language preference. */
  async function activateSystemLocale(): Promise<void> {
    const matched =
      matchSupportedLocale(navigator.languages, localeOptions.value) ??
      DEFAULT_LOCALE;
    await activateLocale(matched);
  }

  /** Persists and applies an explicit locale or the system preference. */
  async function setPreference(
    nextPreference: LocalePreference,
  ): Promise<void> {
    if (nextPreference === SYSTEM_PREFERENCE) {
      preference.value = SYSTEM_PREFERENCE;
      writePreference(SYSTEM_PREFERENCE);
      await activateSystemLocale();
      return;
    }
    const matched = matchSupportedLocale([nextPreference], localeOptions.value);
    if (matched === null) {
      preference.value = SYSTEM_PREFERENCE;
      writePreference(SYSTEM_PREFERENCE);
      await activateSystemLocale();
      return;
    }
    const activated = await activateLocale(matched);
    preference.value = activated === matched ? matched : SYSTEM_PREFERENCE;
    writePreference(preference.value);
  }

  if (preference.value === SYSTEM_PREFERENCE) {
    await activateSystemLocale();
  } else {
    await setPreference(preference.value);
  }
  window.addEventListener("languagechange", () => {
    if (preference.value === SYSTEM_PREFERENCE) {
      void activateSystemLocale();
    }
  });

  return {
    i18n,
    locale: readonly(locale),
    preference: readonly(preference),
    locales: readonly(localeOptions),
    setPreference,
  };
}

/** Returns the translation service installed during frontend bootstrap. */
export function useTranslationService(): TranslationService {
  const service = inject(translationServiceKey);
  if (service === undefined) {
    throw new Error("TranslationService was not provided");
  }
  return service;
}

/** Converts a translation pack into a selectable locale descriptor. */
function localeOption(pack: TranslationPack): LocaleOption {
  return {
    locale: pack.locale,
    name: pack.name,
    direction: pack.direction,
  };
}

/** Discovers optional same-origin translation packs from the runtime manifest. */
async function discoverExternalTranslations(
  externalTranslations: Map<string, ExternalTranslation>,
  localeOptions: { value: readonly LocaleOption[] },
): Promise<void> {
  const manifestUrl = new URL(
    `${import.meta.env.BASE_URL}i18n/manifest.json`,
    window.location.origin,
  );
  try {
    const response = await fetch(manifestUrl);
    if (!response.ok) {
      return;
    }
    const manifest = parseManifest(await response.json());
    const additions: LocaleOption[] = [];
    for (const descriptor of manifest.packs) {
      if (
        localeOptions.value.some(
          (option) => option.locale === descriptor.locale,
        ) ||
        externalTranslations.has(descriptor.locale)
      ) {
        continue;
      }
      const url = new URL(descriptor.path, manifestUrl);
      if (url.origin !== manifestUrl.origin) {
        continue;
      }
      externalTranslations.set(descriptor.locale, { descriptor, url });
      additions.push(descriptor);
    }
    localeOptions.value = [...localeOptions.value, ...additions];
  } catch {
    // Runtime packs are optional; bundled English remains a safe startup path.
  }
}

/** Parses and validates a runtime translation manifest. */
function parseManifest(candidate: unknown): TranslationManifest {
  if (
    !isRecord(candidate) ||
    candidate.schemaVersion !== 1 ||
    !Array.isArray(candidate.packs)
  ) {
    throw new Error("Invalid translation manifest");
  }
  return {
    schemaVersion: 1,
    packs: candidate.packs.map(parseDescriptor),
  };
}

/** Parses one translation-pack descriptor from a runtime manifest. */
function parseDescriptor(candidate: unknown): TranslationPackDescriptor {
  if (
    !isRecord(candidate) ||
    typeof candidate.locale !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.path !== "string" ||
    !isDirection(candidate.direction)
  ) {
    throw new Error("Invalid translation pack descriptor");
  }
  const locale = canonicalLocale(candidate.locale);
  if (locale === null || candidate.name.trim() === "") {
    throw new Error("Invalid translation pack locale");
  }
  return {
    locale,
    name: candidate.name.trim(),
    direction: candidate.direction,
    path: candidate.path,
  };
}

/** Loads and validates one externally supplied translation pack. */
async function loadExternalPack(
  external: ExternalTranslation,
): Promise<TranslationPack> {
  const response = await fetch(external.url);
  if (!response.ok) {
    throw new Error("Could not load translation pack");
  }
  const pack = parseTranslationPack(await response.json());
  if (
    pack.locale !== external.descriptor.locale ||
    pack.direction !== external.descriptor.direction ||
    pack.name !== external.descriptor.name
  ) {
    throw new Error("Translation pack metadata does not match its manifest");
  }
  return pack;
}

/** Parses a translation pack and validates its catalog against English. */
export function parseTranslationPack(candidate: unknown): TranslationPack {
  if (
    !isRecord(candidate) ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.locale !== "string" ||
    typeof candidate.name !== "string" ||
    !isDirection(candidate.direction) ||
    !isRecord(candidate.messages)
  ) {
    throw new Error("Invalid translation pack");
  }
  const locale = canonicalLocale(candidate.locale);
  if (locale === null || candidate.name.trim() === "") {
    throw new Error("Invalid translation pack locale");
  }
  const fallback =
    typeof candidate.fallback === "string"
      ? canonicalLocale(candidate.fallback)
      : null;
  if (typeof candidate.fallback === "string" && fallback === null) {
    throw new Error("Invalid translation pack fallback");
  }
  validateMessages(candidate.messages, enUsMessages);
  return {
    schemaVersion: 1,
    locale,
    name: candidate.name.trim(),
    direction: candidate.direction,
    ...(fallback === null ? {} : { fallback }),
    messages: candidate.messages as DeepPartialMessages<MessageSchema>,
  };
}

/** Validates known catalog keys, value types, and interpolation placeholders. */
function validateMessages(
  candidate: Readonly<Record<string, unknown>>,
  reference: Readonly<Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(candidate)) {
    if (!Object.hasOwn(reference, key)) {
      throw new Error(`Unknown translation key: ${key}`);
    }
    const expected = reference[key];
    if (typeof expected === "string") {
      if (typeof value !== "string" || !samePlaceholders(value, expected)) {
        throw new Error(`Invalid translation message: ${key}`);
      }
    } else if (isRecord(expected) && isRecord(value)) {
      validateMessages(value, expected);
    } else {
      throw new Error(`Invalid translation group: ${key}`);
    }
  }
}

/** Reports whether translated and source messages interpolate the same names. */
function samePlaceholders(candidate: string, reference: string): boolean {
  const candidateNames = placeholderNames(candidate);
  const referenceNames = placeholderNames(reference);
  return (
    candidateNames.length === referenceNames.length &&
    candidateNames.every((name, index) => name === referenceNames[index])
  );
}

/** Extracts sorted named interpolation placeholders from one message. */
function placeholderNames(message: string): string[] {
  return [
    ...new Set(
      [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map(
        (match) => match[1] ?? "",
      ),
    ),
  ].sort();
}

/** Recursively overlays partial translated messages onto a complete catalog. */
function mergeMessages(
  base: MessageSchema,
  overlay: DeepPartialMessages<MessageSchema>,
): MessageSchema {
  return mergeMessageRecords(
    base as unknown as Readonly<Record<string, unknown>>,
    overlay as Readonly<Record<string, unknown>>,
  ) as unknown as MessageSchema;
}

/** Recursively merges two catalog object records. */
function mergeMessageRecords(
  base: Readonly<Record<string, unknown>>,
  overlay: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(base).map(([key, value]) => [
      key,
      isRecord(value) && isRecord(overlay[key])
        ? mergeMessageRecords(value, overlay[key])
        : (overlay[key] ?? value),
    ]),
  );
}

/** Matches browser language tags to available official and plugin locales. */
export function matchSupportedLocale(
  requestedLocales: readonly string[],
  availableLocales: readonly LocaleOption[],
): string | null {
  const available = new Map(
    availableLocales.map((option) => [
      option.locale.toLowerCase(),
      option.locale,
    ]),
  );
  for (const requested of requestedLocales) {
    const canonical = canonicalLocale(requested);
    if (canonical === null) {
      continue;
    }
    const exact = available.get(canonical.toLowerCase());
    if (exact !== undefined) {
      return exact;
    }
    const lower = canonical.toLowerCase();
    if (lower.startsWith("zh-")) {
      const traditional =
        lower.includes("-hant") ||
        /-hk(?:-|$)|-mo(?:-|$)|-tw(?:-|$)/u.test(lower);
      const chinese = available.get(traditional ? "zh-hant" : "zh-hans");
      if (chinese !== undefined) {
        return chinese;
      }
    }
    if (lower.startsWith("en-")) {
      const british = /-au(?:-|$)|-gb(?:-|$)|-ie(?:-|$)|-nz(?:-|$)/u.test(
        lower,
      );
      const english = available.get(british ? "en-gb" : "en-us");
      if (english !== undefined) {
        return english;
      }
    }
    const language = lower.split("-")[0];
    const languageMatch = availableLocales.find(
      (option) =>
        option.locale.toLowerCase() === language ||
        option.locale.toLowerCase().startsWith(`${language}-`),
    );
    if (languageMatch !== undefined) {
      return languageMatch.locale;
    }
  }
  return null;
}

/** Canonicalizes one BCP 47 locale tag without throwing on invalid input. */
function canonicalLocale(locale: string): string | null {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? null;
  } catch {
    return null;
  }
}

/** Reports whether a candidate is a supported document direction. */
function isDirection(candidate: unknown): candidate is LocaleDirection {
  return candidate === "ltr" || candidate === "rtl";
}

/** Reports whether a candidate is a non-array object. */
function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate)
  );
}

/** Reads the saved locale choice while tolerating unavailable browser storage. */
function readPreference(): LocalePreference {
  try {
    return localStorage.getItem(LOCALE_PREFERENCE_KEY) ?? SYSTEM_PREFERENCE;
  } catch {
    return SYSTEM_PREFERENCE;
  }
}

/** Saves the locale choice while tolerating unavailable browser storage. */
function writePreference(preference: LocalePreference): void {
  try {
    localStorage.setItem(LOCALE_PREFERENCE_KEY, preference);
  } catch {
    // Locale selection remains active for the current page.
  }
}

/** Synchronizes document language and writing direction with the active locale. */
function applyDocumentLocale(locale: string, direction: LocaleDirection): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = direction;
}
