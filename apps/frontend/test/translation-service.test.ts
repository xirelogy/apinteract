import { describe, expect, it } from "vitest";

import {
  matchSupportedLocale,
  parseTranslationPack,
} from "@/app/i18n/translation-service";
import type { LocaleOption } from "@/app/i18n/translation-types";

const officialLocales: readonly LocaleOption[] = [
  { locale: "en-US", name: "English (United States)", direction: "ltr" },
  { locale: "en-GB", name: "English (United Kingdom)", direction: "ltr" },
  { locale: "zh-Hans", name: "简体中文", direction: "ltr" },
  { locale: "zh-Hant", name: "繁體中文", direction: "ltr" },
];

describe("translation service", () => {
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
