<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

export type CodeEditorLanguage = "plain" | "json" | "javascript" | "markdown";

/** Provides an accessible text editor with switchable syntax support. */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    language?: CodeEditorLanguage;
    disabled?: boolean;
  }>(),
  {
    language: "plain",
    disabled: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  input: [];
}>();

const host = ref<HTMLDivElement | null>(null);
const dynamicConfiguration = new Compartment();
const languageConfiguration = new Compartment();
let editor: EditorView | undefined;
let synchronizingDocument = false;

const syntaxTheme = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.modifier, tags.controlKeyword],
    color: "var(--accent-secondary)",
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp],
    color: "var(--success)",
  },
  {
    tag: [tags.number, tags.bool, tags.null, tags.atom],
    color: "var(--warning)",
  },
  {
    tag: [tags.comment, tags.docComment],
    color: "var(--text-secondary)",
    fontStyle: "italic",
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--accent-primary)",
  },
  {
    tag: [tags.className, tags.typeName, tags.definition(tags.variableName)],
    color: "var(--accent-primary)",
  },
  {
    tag: [tags.operator, tags.punctuation],
    color: "var(--text-secondary)",
  },
  { tag: tags.invalid, color: "var(--danger)", textDecoration: "underline" },
]);

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    minHeight: "0",
    color: "var(--text-primary)",
    backgroundColor: "var(--surface-code)",
    fontSize: "var(--font-size-xs)",
  },
  "&.cm-focused": {
    outline: "2px solid var(--focus)",
    outlineOffset: "-2px",
  },
  ".cm-scroller": {
    minHeight: "0",
    overflow: "auto",
    fontFamily: "var(--font-mono)",
    lineHeight: "var(--line-height-code)",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "var(--space-2) 0",
    caretColor: "var(--text-primary)",
  },
  ".cm-line": {
    padding: "0 var(--space-3)",
  },
  ".cm-gutters": {
    color: "var(--text-secondary)",
    backgroundColor: "var(--surface-secondary)",
    borderRight: "1px solid var(--border-subtle)",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor:
      "color-mix(in srgb, var(--accent-primary) 9%, transparent)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor:
      "color-mix(in srgb, var(--accent-secondary) 24%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--text-primary)",
  },
  ".cm-panels, .cm-tooltip": {
    color: "var(--text-primary)",
    backgroundColor: "var(--surface-primary)",
    borderColor: "var(--border-subtle)",
  },
});

/** Selects the parser extension for one editor language. */
function languageExtension(language: CodeEditorLanguage): Extension {
  if (language === "javascript") return javascript();
  if (language === "json") return json();
  if (language === "markdown") return markdown();
  return [];
}

/** Builds the extensions that follow mutable component properties. */
function dynamicExtensions(): Extension {
  return [
    EditorState.readOnly.of(props.disabled),
    EditorView.editable.of(!props.disabled),
    EditorView.contentAttributes.of({
      "aria-label": props.label,
      "aria-multiline": "true",
      autocapitalize: "off",
      autocomplete: "off",
      spellcheck: "false",
    }),
  ];
}

/** Emits document changes created through the interactive editor. */
function publishDocument(update: { readonly docChanged: boolean }): void {
  if (!update.docChanged || synchronizingDocument || editor === undefined) {
    return;
  }
  emit("update:modelValue", editor.state.doc.toString());
  emit("input");
}

onMounted(() => {
  if (host.value === null) return;
  editor = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        languageConfiguration.of(languageExtension(props.language)),
        syntaxHighlighting(syntaxTheme),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
        editorTheme,
        dynamicConfiguration.of(dynamicExtensions()),
        EditorView.updateListener.of(publishDocument),
      ],
    }),
  });
});

watch(
  () => props.modelValue,
  (value) => {
    if (editor === undefined || editor.state.doc.toString() === value) return;
    synchronizingDocument = true;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
    });
    synchronizingDocument = false;
  },
);

watch([() => props.disabled, () => props.label], () => {
  editor?.dispatch({
    effects: dynamicConfiguration.reconfigure(dynamicExtensions()),
  });
});

watch(
  () => props.language,
  (language) => {
    editor?.dispatch({
      effects: languageConfiguration.reconfigure(languageExtension(language)),
    });
  },
);

onBeforeUnmount(() => {
  editor?.destroy();
  editor = undefined;
});
</script>

<template>
  <div
    ref="host"
    class="code-editor-control"
    :data-language="language"
    :data-disabled="disabled ? '' : undefined"
  ></div>
</template>
