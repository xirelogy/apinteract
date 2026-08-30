import type { PluginRegistrationContext } from "@apinteract/plugin-api";
import type {
  RequestContentEditorContext,
  WireBodyEditorMountOptions,
  FrontendPluginProviders,
} from "@apinteract/plugin-api/frontend";
import { localize } from "@apinteract/plugin-sdk/frontend/localization";

/** Registers JSON request formatting and structured response projection. */
export function register(
  context: PluginRegistrationContext<FrontendPluginProviders>,
): void {
  context.register("request.content", {
    id: "json",
    label: { default: "JSON" },
    mediaTypes: ["application/json", "*+json"],
    order: 20,
    createBody: (previous) => ({
      kind: "text",
      contentType: "application/json",
      text: previous.kind === "text" ? previous.text : "",
    }),
    isDefaultFor: () => false,
    effectiveContentType: (body) =>
      body.kind === "text" ? body.contentType : null,
    mountEditor: (container, editor) => mountRequestEditor(container, editor),
  });
  context.register("response.content", {
    id: "json",
    label: { default: "JSON" },
    mediaTypes: ["application/json", "text/json", "*+json"],
    isAvailable: ({ execution }) => execution.bodyPreview !== undefined,
    isDefault: ({ execution, previewComplete }) =>
      previewComplete &&
      execution.bodyPreview !== undefined &&
      parseJson(execution.bodyPreview).valid,
    mountView: (container, view) => {
      const optionsFor = (current: typeof view) => {
        const source = current.execution.bodyPreview ?? "";
        const parsed = parseJson(source);
        return {
          document: parsed.valid ? parsed.value : source,
          label: localize(
            "Formatted JSON response body",
            {
              "zh-CN": "格式化的 JSON 响应体",
              "zh-TW": "格式化的 JSON 回應本文",
            },
            current.locale,
          ),
          language: "json" as const,
          readOnly: true,
          foldable: true,
        };
      };
      const notice = document.createElement("p");
      notice.className = "response-preview-notice";
      notice.setAttribute("role", "status");
      const editorContainer = document.createElement("div");
      container.replaceChildren(notice, editorContainer);

      /** Keeps invalid-content feedback under plugin ownership. */
      const updateNotice = (current: typeof view) => {
        notice.hidden = parseJson(current.execution.bodyPreview ?? "").valid;
        notice.textContent = localize(
          "The response body could not be parsed as JSON.",
          {
            "zh-CN": "响应体无法解析为 JSON。",
            "zh-TW": "回應本文無法解析為 JSON。",
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

/** Validates JSON and formats structural whitespace without changing numbers. */
function parseJson(
  source: string,
):
  | { readonly valid: true; readonly value: string }
  | { readonly valid: false } {
  try {
    JSON.parse(source);
  } catch {
    return { valid: false };
  }
  return { valid: true, value: formatWhitespace(source) };
}

/** Mounts the executable JSON request editor through the shared CodeMirror mechanism. */
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
    codeLanguage: "json",
    contentTypePlaceholder: "application/json",
    format: (source) => {
      const parsed = parseJson(source);
      return parsed.valid
        ? { valid: true, value: parsed.value }
        : {
            valid: false,
            error: localize(
              "The request body is not valid JSON.",
              {
                "zh-CN": "请求体不是有效的 JSON。",
                "zh-TW": "請求本文不是有效的 JSON。",
              },
              current.locale,
            ),
          };
    },
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

/** Inserts conventional JSON whitespace while preserving source tokens. */
function formatWhitespace(source: string): string {
  let result = "";
  let indentation = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (/\s/u.test(character)) continue;
    if (character === "{" || character === "[") {
      result += character;
      if (
        nextNonWhitespace(source, index + 1) !== (character === "{" ? "}" : "]")
      ) {
        indentation += 1;
        result += `\n${"  ".repeat(indentation)}`;
      }
      continue;
    }
    if (character === "}" || character === "]") {
      if (
        previousNonWhitespace(source, index - 1) !==
        (character === "}" ? "{" : "[")
      ) {
        indentation = Math.max(0, indentation - 1);
        result += `\n${"  ".repeat(indentation)}`;
      }
      result += character;
      continue;
    }
    if (character === ",") {
      result += `,\n${"  ".repeat(indentation)}`;
      continue;
    }
    result += character === ":" ? ": " : character;
  }
  return result;
}

/** Returns the next non-whitespace source character. */
function nextNonWhitespace(source: string, from: number): string | undefined {
  for (let index = from; index < source.length; index += 1) {
    if (!/\s/u.test(source[index]!)) return source[index];
  }
  return undefined;
}

/** Returns the previous non-whitespace source character. */
function previousNonWhitespace(
  source: string,
  from: number,
): string | undefined {
  for (let index = from; index >= 0; index -= 1) {
    if (!/\s/u.test(source[index]!)) return source[index];
  }
  return undefined;
}
