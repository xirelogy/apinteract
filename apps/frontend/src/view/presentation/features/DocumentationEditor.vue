<!-- eslint-disable vue/no-v-html -- renderedNotes is DOMPurify-sanitized HTML. -->
<script setup lang="ts">
import { computed, ref } from "vue";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { Eye, PencilLine } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import FormField from "@/view/presentation/controls/FormField.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import CodeEditor from "@/view/presentation/controls/CodeEditor.vue";
import TabsList from "@/view/presentation/controls/tabs/TabsList.vue";
import TabsPanel from "@/view/presentation/controls/tabs/TabsPanel.vue";
import TabsRoot from "@/view/presentation/controls/tabs/TabsRoot.vue";
import TabsTrigger from "@/view/presentation/controls/tabs/TabsTrigger.vue";

const props = defineProps<{
  description: string;
  notes: string;
  disabled: boolean;
}>();
const emit = defineEmits<{
  "update:description": [value: string];
  "update:notes": [value: string];
}>();
const { t } = useI18n();
const mode = ref<"edit" | "preview">("edit");
const textEncoder = new TextEncoder();
const descriptionBytes = computed(
  () => textEncoder.encode(props.description).length,
);
const notesBytes = computed(() => textEncoder.encode(props.notes).length);
const descriptionNearLimit = computed(() => descriptionBytes.value >= 1_843);
const notesNearLimit = computed(() => notesBytes.value >= 235_930);
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
const defaultLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, index, options, _environment, renderer) =>
    renderer.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (
  tokens,
  index,
  options,
  environment,
  renderer,
) => {
  tokens[index]?.attrSet("target", "_blank");
  tokens[index]?.attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, index, options, environment, renderer);
};
markdown.renderer.rules.image = (tokens, index) =>
  markdown.utils.escapeHtml(tokens[index]?.content ?? "");

const renderedNotes = computed(() =>
  DOMPurify.sanitize(markdown.render(props.notes), {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target"],
    FORBID_TAGS: ["img", "picture", "source", "video", "audio", "iframe"],
    FORBID_ATTR: ["style", "srcset"],
  }),
);
</script>

<template>
  <div class="documentation-editor">
    <div class="documentation-description">
      <FormField :label="t('documentation.description')">
        <TextInput
          :model-value="description"
          :aria-label="t('documentation.description')"
          :placeholder="t('documentation.descriptionPlaceholder')"
          :maxlength="2048"
          :disabled="disabled"
          @update:model-value="emit('update:description', $event)"
        />
      </FormField>
      <p v-if="descriptionNearLimit" class="documentation-limit" role="status">
        {{
          t("documentation.limit", {
            used: descriptionBytes,
            maximum: 2048,
          })
        }}
      </p>
    </div>
    <div class="documentation-notes">
      <div class="documentation-notes-heading">
        <span>{{ t("documentation.notes") }}</span>
        <TabsRoot v-model="mode" class="documentation-mode-tabs">
          <TabsList :label="t('documentation.notesMode')">
            <TabsTrigger
              value="edit"
              class="documentation-mode-trigger"
              :aria-label="t('documentation.edit')"
              :title="t('documentation.edit')"
            >
              <PencilLine :size="15" aria-hidden="true" />
            </TabsTrigger>
            <TabsTrigger
              value="preview"
              class="documentation-mode-trigger"
              :aria-label="t('documentation.preview')"
              :title="t('documentation.preview')"
            >
              <Eye :size="15" aria-hidden="true" />
            </TabsTrigger>
          </TabsList>
        </TabsRoot>
      </div>
      <TabsRoot v-model="mode" class="documentation-notes-content">
        <TabsPanel value="edit" class="documentation-source-panel">
          <CodeEditor
            class="documentation-source-input"
            :model-value="notes"
            :label="t('documentation.notesSource')"
            language="markdown"
            :disabled="disabled"
            @update:model-value="emit('update:notes', $event)"
          />
        </TabsPanel>
        <TabsPanel value="preview" class="documentation-preview-panel">
          <div
            v-if="notes.trim() !== ''"
            class="markdown-preview"
            :innerHTML="renderedNotes"
          ></div>
          <p v-else class="documentation-empty-preview">
            {{ t("documentation.emptyPreview") }}
          </p>
        </TabsPanel>
      </TabsRoot>
      <p v-if="notesNearLimit" class="documentation-limit" role="status">
        {{
          t("documentation.limit", {
            used: notesBytes,
            maximum: 262144,
          })
        }}
      </p>
    </div>
  </div>
</template>
