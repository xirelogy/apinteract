import type { PluginRegistrationContext } from "@apinteract/plugin-api";
import type {
  FrontendPluginProviders,
  RequestBodyDefinition,
  RequestBodyHostKind,
  RequestContentContribution,
  WireBodyEditorMountOptions,
} from "@apinteract/plugin-api/frontend";
import { localize } from "@apinteract/plugin-sdk/frontend/localization";

const zhHans = "zh-CN";
const zhHant = "zh-TW";

/** Registers host-backed baseline HTTP wire editors and plain-text responses. */
export function register(
  context: PluginRegistrationContext<FrontendPluginProviders>,
): void {
  context.register(
    "request.content",
    wireContent({
      id: "none",
      label: {
        default: "None",
        translations: { [zhHans]: "无", [zhHant]: "無" },
      },
      wireKind: "none",
      order: 0,
      createBody: () => ({ kind: "none" }),
    }),
  );
  context.register(
    "request.content",
    wireContent({
      id: "text",
      label: {
        default: "Plain text",
        translations: { [zhHans]: "纯文本", [zhHant]: "純文字" },
      },
      wireKind: "text",
      order: 10,
      contentTypePlaceholder: "text/plain",
      createBody: (previous) => ({
        kind: "text",
        contentType: "text/plain",
        text: previous.kind === "text" ? previous.text : "",
      }),
    }),
  );
  context.register(
    "request.content",
    wireContent({
      id: "urlencoded",
      label: {
        default: "Form (URL-encoded)",
        translations: {
          [zhHans]: "表单（URL 编码）",
          [zhHant]: "表單（URL 編碼）",
        },
      },
      wireKind: "urlencoded",
      order: 30,
      contentTypePlaceholder: "application/x-www-form-urlencoded",
      createBody: (previous) => ({
        kind: "urlencoded",
        contentType: null,
        fields:
          previous.kind === "urlencoded" || previous.kind === "multipart"
            ? textFields(previous.fields)
            : [],
      }),
    }),
  );
  context.register(
    "request.content",
    wireContent({
      id: "multipart",
      label: {
        default: "Multipart Form",
        translations: { [zhHans]: "多部分表单", [zhHant]: "多部分表單" },
      },
      wireKind: "multipart",
      order: 40,
      contentTypePlaceholder: "multipart/form-data",
      createBody: (previous) => ({
        kind: "multipart",
        contentType: null,
        boundary:
          previous.kind === "multipart" ? previous.boundary : createBoundary(),
        fields:
          previous.kind === "urlencoded" || previous.kind === "multipart"
            ? previous.fields.map(cloneField)
            : [],
      }),
    }),
  );
  context.register(
    "request.content",
    wireContent({
      id: "file",
      label: {
        default: "Binary File",
        translations: { [zhHans]: "二进制文件", [zhHant]: "二進位檔案" },
      },
      wireKind: "file",
      order: 50,
      createBody: (previous) =>
        previous.kind === "file"
          ? { ...previous, attachment: { ...previous.attachment } }
          : { kind: "none" },
    }),
  );
  context.register("response.content", {
    id: "text",
    label: {
      default: "Text",
      translations: { [zhHans]: "文本", [zhHant]: "文字" },
    },
    mediaTypes: [
      "text/*",
      "application/javascript",
      "application/x-javascript",
      "application/ecmascript",
      "application/typescript",
    ],
    isAvailable: ({ execution }) => execution.bodyPreview !== undefined,
    isDefault: () => false,
    mountView: (container, view) =>
      mapViewHandle(
        view,
        (value) => ({
          document: value.execution.bodyPreview ?? "",
          label: localize(
            "Text response body",
            { [zhHans]: "文本响应体", [zhHant]: "文字回應本文" },
            value.locale,
          ),
          readOnly: true,
        }),
        (options) => view.ui.mountCodeEditor(container, options),
      ),
  });
}

interface WireContentOptions {
  readonly id: string;
  readonly label: RequestContentContribution["label"];
  readonly wireKind: RequestBodyHostKind;
  readonly order: number;
  readonly contentTypePlaceholder?: string;
  createBody(previous: RequestBodyDefinition): RequestBodyDefinition;
}

/** Creates one executable contribution over a canonical HTTP wire editor. */
function wireContent(options: WireContentOptions): RequestContentContribution {
  return {
    id: options.id,
    label: options.label,
    order: options.order,
    createBody: (previous) => options.createBody(previous),
    isDefaultFor: (body) => body.kind === options.wireKind,
    effectiveContentType: effectiveContentType,
    mountEditor: (container, editor) =>
      mapViewHandle(
        editor,
        (value): WireBodyEditorMountOptions => ({
          body: value.body,
          wireKind: options.wireKind,
          label: localize(
            "Raw request body",
            { [zhHans]: "原始请求体", [zhHant]: "原始請求本文" },
            value.locale,
          ),
          disabled: value.disabled,
          variablePreviews: value.variablePreviews,
          ...(value.uploadAttachment === undefined
            ? {}
            : { uploadAttachment: value.uploadAttachment }),
          contentTypePlaceholder: options.contentTypePlaceholder ?? "",
          onChange: value.updateBody,
        }),
        (value) => editor.ui.mountWireBodyEditor(container, value),
      ),
  };
}

/** Maps host mechanism updates back to the owning executable plugin context. */
function mapViewHandle<TContext, TOptions>(
  initial: TContext,
  optionsFor: (context: TContext) => TOptions,
  mount: (options: TOptions) => {
    update(options: TOptions): void;
    destroy(): void;
  },
): { update(context: TContext): void; destroy(): void } {
  const handle = mount(optionsFor(initial));
  return {
    update(context) {
      handle.update(optionsFor(context));
    },
    destroy() {
      handle.destroy();
    },
  };
}

/** Returns the generated Content-Type for one canonical HTTP body. */
function effectiveContentType(body: RequestBodyDefinition): string | null {
  if (body.kind === "none") return null;
  if (body.kind === "text") return body.contentType;
  if (body.kind === "file") {
    return body.contentType ?? body.attachment.contentType;
  }
  if (body.kind === "urlencoded") {
    return body.contentType ?? "application/x-www-form-urlencoded";
  }
  const contentType = body.contentType ?? "multipart/form-data";
  return `${contentType}; boundary=${body.boundary}`;
}

/** Creates a sufficiently unique browser-side multipart boundary. */
function createBoundary(): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  return `----APInteractBoundary${[...random]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Retains only textual fields when switching to URL encoding. */
function textFields(
  fields:
    | Extract<RequestBodyDefinition, { kind: "multipart" }>["fields"]
    | Extract<RequestBodyDefinition, { kind: "urlencoded" }>["fields"],
): Extract<RequestBodyDefinition, { kind: "urlencoded" }>["fields"] {
  return fields.flatMap((field) => ("kind" in field ? [] : [{ ...field }]));
}

/** Clones a canonical form field without sharing attachment metadata. */
function cloneField(
  field: Extract<
    RequestBodyDefinition,
    { kind: "multipart" }
  >["fields"][number],
): Extract<RequestBodyDefinition, { kind: "multipart" }>["fields"][number] {
  return "kind" in field
    ? { ...field, attachment: { ...field.attachment } }
    : { ...field };
}
