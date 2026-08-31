import { parser } from "@lezer/xml";
import type { PluginRegistrationContext } from "@apinteract/plugin-api";
import type {
  FrontendPluginProviders,
  RequestContentEditorContext,
  WireBodyEditorMountOptions,
} from "@apinteract/plugin-api/frontend";
import { localize } from "@apinteract/plugin-sdk/frontend/localization";

/** Registers XML request editing and structured response parsing. */
export function register(
  context: PluginRegistrationContext<FrontendPluginProviders>,
): void {
  context.register("request.content", {
    id: "xml",
    label: { default: "XML" },
    mediaTypes: ["application/xml", "text/xml", "*+xml"],
    order: 25,
    createBody: (previous) => ({
      kind: "text",
      contentType: "application/xml",
      text: previous.kind === "text" ? previous.text : "",
    }),
    isDefaultFor: () => false,
    effectiveContentType: (body) =>
      body.kind === "text" ? body.contentType : null,
    mountEditor: (container, editor) => mountRequestEditor(container, editor),
  });
  context.register("response.content", {
    id: "xml",
    label: { default: "XML" },
    mediaTypes: ["application/xml", "text/xml", "*+xml"],
    isAvailable: ({ execution }) => execution.bodyPreview !== undefined,
    isDefault: ({ execution, previewComplete }) =>
      previewComplete &&
      execution.bodyPreview !== undefined &&
      parseXml(execution.bodyPreview).valid,
    mountView: (container, view) => {
      const optionsFor = (current: typeof view) => ({
        document: current.execution.bodyPreview ?? "",
        label: localize(
          "Structured XML response body",
          {
            "zh-CN": "结构化 XML 响应体",
            "zh-TW": "結構化 XML 回應本文",
          },
          current.locale,
        ),
        language: "xml" as const,
        readOnly: true,
        foldable: true,
      });
      const notice = document.createElement("p");
      notice.className = "response-preview-notice";
      notice.setAttribute("role", "status");
      const editorContainer = document.createElement("div");
      container.replaceChildren(notice, editorContainer);

      /** Keeps invalid-content feedback under plugin ownership. */
      const updateNotice = (current: typeof view) => {
        notice.hidden = parseXml(current.execution.bodyPreview ?? "").valid;
        notice.textContent = localize(
          "The response body could not be parsed as XML.",
          {
            "zh-CN": "响应体无法解析为 XML。",
            "zh-TW": "回應本文無法解析為 XML。",
          },
          current.locale,
        );
      };

      updateNotice(view);
      const handle = view.ui.mountCodeEditor(editorContainer, optionsFor(view));
      return {
        update(current) {
          updateNotice(current);
          handle.update(optionsFor(current));
        },
        destroy() {
          handle.destroy();
          container.replaceChildren();
        },
      };
    },
  });
}

/** Mounts the source-preserving XML request editor through the shared wire mechanism. */
function mountRequestEditor(
  container: HTMLElement,
  editor: RequestContentEditorContext,
) {
  const optionsFor = (
    current: RequestContentEditorContext,
  ): WireBodyEditorMountOptions => ({
    body: current.body,
    wireKind: "text",
    label: localize(
      "Raw request body",
      { "zh-CN": "原始请求体", "zh-TW": "原始請求本文" },
      current.locale,
    ),
    disabled: current.disabled,
    variablePreviews: current.variablePreviews,
    ...(current.uploadAttachment === undefined
      ? {}
      : { uploadAttachment: current.uploadAttachment }),
    codeLanguage: "xml",
    contentTypePlaceholder: "application/xml",
    onChange: current.updateBody,
  });
  const handle = editor.ui.mountWireBodyEditor(container, optionsFor(editor));
  return {
    update(current: RequestContentEditorContext) {
      handle.update(optionsFor(current));
    },
    destroy() {
      handle.destroy();
    },
  };
}

/** Validates XML with a non-executing parser and preserves exact source. */
function parseXml(source: string): { readonly valid: boolean } {
  const tree = parser.parse(source);
  let valid = source.trim() !== "";
  tree.iterate({
    enter(node) {
      if (node.type.isError) valid = false;
    },
  });
  return { valid };
}
