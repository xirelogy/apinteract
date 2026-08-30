import {
  getCurrentInstance,
  h,
  render,
  shallowRef,
  type AppContext,
  type Component,
  type ShallowRef,
} from "vue";
import type {
  CodeEditorMountOptions,
  FrontendPluginUi,
  FrontendPluginViewHandle,
  ImageViewerMountOptions,
  PluginLabel,
  SandboxedDocumentMountOptions,
  WireBodyEditorMountOptions,
} from "@apinteract/plugin-api/frontend";

import CodeEditor from "@/view/presentation/controls/CodeEditor.vue";
import type { CodeEditorLanguage as HostCodeEditorLanguage } from "@/view/presentation/controls/CodeEditor.vue";
import HtmlResponsePreview from "@/view/presentation/features/HtmlResponsePreview.vue";
import ImageResponsePreview from "@/view/presentation/features/ImageResponsePreview.vue";
import WireRequestBodyEditor from "@/view/presentation/features/WireRequestBodyEditor.vue";

/** Creates host UI mechanisms bound to the current Vue application context. */
export function useFrontendPluginUi(): FrontendPluginUi {
  const appContext = getCurrentInstance()?.appContext;
  if (appContext === undefined) {
    throw new Error(
      "Frontend plugin UI must be created during component setup",
    );
  }
  return {
    mountCodeEditor: (container, options) =>
      mountVueMechanism(
        container,
        appContext,
        CodeEditor,
        options,
        (value) => ({
          modelValue: value.document,
          label: value.label,
          language: hostCodeEditorLanguage(value.language),
          disabled: value.disabled ?? false,
          readOnly: value.readOnly ?? false,
          foldable: value.foldable ?? false,
          "onUpdate:modelValue": value.onChange,
        }),
        "code-editor-plugin-view",
      ),
    mountWireBodyEditor: (container, options) =>
      mountVueMechanism(
        container,
        appContext,
        WireRequestBodyEditor,
        options,
        (value) => ({
          body: value.body,
          wireKind: value.wireKind,
          label: value.label,
          disabled: value.disabled,
          variablePreviews: value.variablePreviews,
          uploadAttachment: value.uploadAttachment ?? null,
          codeLanguage: hostCodeEditorLanguage(value.codeLanguage),
          contentTypePlaceholder: value.contentTypePlaceholder ?? "",
          format: value.format,
          onChange: value.onChange,
        }),
        "wire-body-plugin-view",
      ),
    mountSandboxedDocument: (container, options) =>
      mountVueMechanism(
        container,
        appContext,
        HtmlResponsePreview,
        options,
        (value) => ({ source: value.source, title: value.title }),
      ),
    mountImageViewer: (container, options) =>
      mountVueMechanism(
        container,
        appContext,
        ImageResponsePreview,
        options,
        (value) => ({
          executionId: value.executionId,
          mediaType: value.mediaType,
          byteLength: value.byteLength,
          loadBody: value.loadBody,
          inspect: value.inspect,
        }),
      ),
  };
}

const hostCodeEditorLanguages = new Set<HostCodeEditorLanguage>([
  "plain",
  "json",
  "javascript",
  "markdown",
  "xml",
]);

/** Maps an open plugin language identifier to a capability supported by this host. */
function hostCodeEditorLanguage(
  language: string | undefined,
): HostCodeEditorLanguage {
  return hostCodeEditorLanguages.has(language as HostCodeEditorLanguage)
    ? (language as HostCodeEditorLanguage)
    : "plain";
}

/** Mounts a reactive Vue-backed mechanism behind the framework-neutral ABI. */
function mountVueMechanism<TOptions>(
  container: HTMLElement,
  appContext: AppContext,
  component: Component,
  initial: TOptions,
  propsFor: (options: TOptions) => Record<string, unknown>,
  containerClass?: string,
): FrontendPluginViewHandle<TOptions> {
  const current = shallowRef(initial) as ShallowRef<TOptions>;
  const wrapper: Component = {
    /** Renders the current mechanism options without exposing Vue to plugins. */
    setup() {
      return () => h(component, propsFor(current.value));
    },
  };
  const vnode = h(wrapper);
  vnode.appContext = appContext;
  if (containerClass !== undefined) container.classList.add(containerClass);
  render(vnode, container);
  return {
    /** Re-renders the mechanism with one immutable option snapshot. */
    update(options) {
      current.value = options;
    },
    /** Unmounts the mechanism and releases its Vue render tree. */
    destroy() {
      render(null, container);
      if (containerClass !== undefined)
        container.classList.remove(containerClass);
    },
  };
}

export type {
  CodeEditorMountOptions,
  ImageViewerMountOptions,
  SandboxedDocumentMountOptions,
  WireBodyEditorMountOptions,
};

/** Resolves a package-owned label using exact and base-language fallbacks. */
export function localizePluginLabel(
  label: PluginLabel,
  locale: string,
): string {
  return (
    label.translations?.[locale] ??
    label.translations?.[locale.split("-")[0] ?? ""] ??
    label.default
  );
}
