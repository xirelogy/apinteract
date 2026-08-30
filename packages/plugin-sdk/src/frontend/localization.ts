/** Resolves package-owned text through exact locale, base language, and default fallbacks. */
export function localize(
  fallback: string,
  translations: Readonly<Record<string, string>>,
  locale: string,
): string {
  return (
    translations[locale] ?? translations[locale.split("-")[0] ?? ""] ?? fallback
  );
}
