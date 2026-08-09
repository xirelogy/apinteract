import { describe, expect, it } from "vitest";

import {
  matchSupportedLocale,
  parseTranslationPack,
} from "@/app/i18n/translation-service";
import { officialTranslationPacks } from "@/app/i18n/official-locales";
import { enUsMessages } from "@/app/i18n/messages";
import type { LocaleOption } from "@/app/i18n/translation-types";

const officialLocales: readonly LocaleOption[] = [
  { locale: "en-US", name: "English (United States)", direction: "ltr" },
  { locale: "en-GB", name: "English (United Kingdom)", direction: "ltr" },
  { locale: "zh-Hans", name: "简体中文", direction: "ltr" },
  { locale: "zh-Hant", name: "繁體中文", direction: "ltr" },
];

/** Verifies that every translated message leaf differs from its English source. */
function expectLocalizedLeaves(
  translated: Record<string, unknown>,
  english: Record<string, unknown>,
  section: string,
): void {
  for (const [key, englishValue] of Object.entries(english)) {
    const translatedValue = translated[key];
    const path = `${section}.${key}`;
    if (typeof englishValue === "string") {
      expect(translatedValue, path).not.toBe(englishValue);
      continue;
    }
    expectLocalizedLeaves(
      translatedValue as Record<string, unknown>,
      englishValue as Record<string, unknown>,
      path,
    );
  }
}

describe("translation service", () => {
  it("fully localizes variable and environment messages in Chinese", () => {
    for (const locale of ["zh-Hans", "zh-Hant"] as const) {
      const pack = officialTranslationPacks.find(
        (candidate) => candidate.locale === locale,
      );
      expect(pack).toBeDefined();
      expectLocalizedLeaves(
        pack?.messages.environment as unknown as Record<string, unknown>,
        enUsMessages.environment,
        `${locale}.environment`,
      );
      expectLocalizedLeaves(
        pack?.messages.variables as unknown as Record<string, unknown>,
        enUsMessages.variables,
        `${locale}.variables`,
      );
    }
  });

  it("matches regional browser languages to official locales", () => {
    expect(matchSupportedLocale(["en-AU"], officialLocales)).toBe("en-GB");
    expect(matchSupportedLocale(["en-CA"], officialLocales)).toBe("en-US");
    expect(matchSupportedLocale(["zh-CN"], officialLocales)).toBe("zh-Hans");
    expect(matchSupportedLocale(["zh-HK"], officialLocales)).toBe("zh-Hant");
  });

  it("accepts partial plugin catalogs with known placeholders", () => {
    expect(
      parseTranslationPack({
        schemaVersion: 1,
        locale: "fr-CA",
        name: "Français (Canada)",
        direction: "ltr",
        messages: {
          header: {
            logout: "Déconnecter {name}",
          },
        },
      }),
    ).toMatchObject({
      locale: "fr-CA",
      messages: {
        header: {
          logout: "Déconnecter {name}",
        },
      },
    });
  });

  it("rejects unknown keys and incompatible placeholders", () => {
    expect(() =>
      parseTranslationPack({
        schemaVersion: 1,
        locale: "fr",
        name: "Français",
        direction: "ltr",
        messages: {
          unknown: "Inconnue",
        },
      }),
    ).toThrow("Unknown translation key");
    expect(() =>
      parseTranslationPack({
        schemaVersion: 1,
        locale: "fr",
        name: "Français",
        direction: "ltr",
        messages: {
          header: {
            logout: "Déconnecter {user}",
          },
        },
      }),
    ).toThrow("Invalid translation message");
  });
});
