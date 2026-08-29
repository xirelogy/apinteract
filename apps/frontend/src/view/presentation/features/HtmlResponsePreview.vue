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
  "href",
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

/** Builds a sanitized document whose iframe policy blocks every network sink. */
const sourceDocument = computed(() => {
  const content = DOMPurify.sanitize(props.source, {
    USE_PROFILES: { html: true },
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'">
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 1rem; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; }
</style>
</head>
<body>${content}</body>
</html>`;
});
</script>

<template>
  <iframe
    class="html-response-preview"
    :title="title"
    :srcdoc="sourceDocument"
    sandbox=""
    referrerpolicy="no-referrer"
  ></iframe>
</template>
