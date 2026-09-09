import { readFileSync } from "node:fs";
import { domainToASCII } from "node:url";

interface PublicSuffixRules {
  readonly exact: ReadonlySet<string>;
  readonly wildcard: ReadonlySet<string>;
  readonly exception: ReadonlySet<string>;
}

const RULES = parsePublicSuffixList(
  readFileSync(new URL("./public_suffix_list.dat", import.meta.url), "utf8"),
);

/** Reports whether a canonical domain is itself an ICANN or private suffix. */
export function isPublicSuffix(domain: string): boolean {
  const canonical = canonicalRule(domain);
  if (canonical === "") return false;
  const labels = canonical.split(".");
  let prevailingLabels = 1;
  for (let index = 0; index < labels.length; index += 1) {
    const candidate = labels.slice(index).join(".");
    if (RULES.exception.has(candidate)) {
      prevailingLabels = labels.length - index - 1;
      return labels.length === prevailingLabels;
    }
    if (RULES.exact.has(candidate)) {
      prevailingLabels = Math.max(prevailingLabels, labels.length - index);
    }
    if (index > 0 && RULES.wildcard.has(labels.slice(index).join("."))) {
      prevailingLabels = Math.max(prevailingLabels, labels.length - index + 1);
    }
  }
  return labels.length === prevailingLabels;
}

/** Parses the complete PSL text, including wildcard and exception syntax. */
function parsePublicSuffixList(source: string): PublicSuffixRules {
  const exact = new Set<string>();
  const wildcard = new Set<string>();
  const exception = new Set<string>();
  for (const sourceLine of source.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (line === "" || line.startsWith("//")) continue;
    if (line.startsWith("!")) {
      const rule = canonicalRule(line.slice(1));
      if (rule !== "") exception.add(rule);
      continue;
    }
    if (line.startsWith("*.")) {
      const rule = canonicalRule(line.slice(2));
      if (rule !== "") wildcard.add(rule);
      continue;
    }
    const rule = canonicalRule(line);
    if (rule !== "") exact.add(rule);
  }
  return { exact, wildcard, exception };
}

/** Canonicalizes one hostname-shaped PSL rule for comparisons. */
function canonicalRule(value: string): string {
  return domainToASCII(value.normalize("NFC"))
    .toLowerCase()
    .replace(/\.$/u, "");
}
