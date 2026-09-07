<script setup lang="ts">
import { computed } from "vue";
import DOMPurify from "dompurify";

const props = defineProps<{
  source: string;
  title: string;
}>();

const prohibitedUrlAttributes = [
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "longdesc",
  "manifest",
  "ping",
  "poster",
  "profile",
  "src",
  "srcset",
  "usemap",
  "xlink:href",
];

const classicJavaScriptTypes = new Set([
  "",
  "application/ecmascript",
  "application/javascript",
  "text/ecmascript",
  "text/javascript",
]);
const sameDocumentFragment = /^#[A-Za-z][\w:.-]*$/u;

/** Extracts executable inline classic scripts while rejecting external and module loading. */
function inlineClassicScripts(source: string): readonly string[] {
  const document = new DOMParser().parseFromString(source, "text/html");
  return [...document.scripts].flatMap((script) => {
    const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
    return script.hasAttribute("src") || !classicJavaScriptTypes.has(type)
      ? []
      : [script.textContent ?? ""];
  });
}

/** Extracts inline CSS that the sanitizer deliberately excludes from untrusted markup. */
function inlineStyles(source: string): readonly string[] {
  const document = new DOMParser().parseFromString(source, "text/html");
  return [...document.querySelectorAll("style")].map(
    (style) => style.textContent ?? "",
  );
}

/** Serializes response scripts after sanitized markup so DOM-enhancement runtimes can initialize. */
function serializeInlineScripts(scripts: readonly string[]): string {
  const openingTag = `<script>`;
  const closingTag = `<` + `/script>`;
  return scripts.map((script) => openingTag + script + closingTag).join("\n");
}

/** Serializes response CSS after host defaults while CSP blocks every referenced resource. */
function serializeInlineStyles(styles: readonly string[]): string {
  const openingTag = `<style>`;
  const closingTag = `<` + `/style>`;
  return styles.map((style) => openingTag + style + closingTag).join("\n");
}

/** Builds an opaque-origin document that permits inline DOM behavior but blocks network sinks. */
const sourceDocument = computed(() => {
  const scripts = inlineClassicScripts(props.source);
  const styles = inlineStyles(props.source);
  const content = DOMPurify.sanitize(props.source, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: sameDocumentFragment,
    FORBID_TAGS: [
      "base",
      "embed",
      "form",
      "frame",
      "frameset",
      "iframe",
      "link",
      "meta",
      "object",
      "script",
    ],
    FORBID_ATTR: prohibitedUrlAttributes,
  });
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'none'">
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 1rem; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; }
</style>
${serializeInlineStyles(styles)}
</head>
<body>${content}${serializeInlineScripts(scripts)}</body>
</html>`;
});
</script>

<template>
  <iframe
    class="html-response-preview"
    :title="title"
    :srcdoc="sourceDocument"
    sandbox="allow-scripts"
    referrerpolicy="no-referrer"
  ></iframe>
</template>
