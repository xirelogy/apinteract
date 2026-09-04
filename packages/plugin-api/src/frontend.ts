import type { APInteractPluginModule } from "./core.js";

export type RequestBodyHostKind = RequestBodyDefinition["kind"];

/** Describes one editable name/value field in a structured request body. */
export interface RequestBodyField {
  readonly name: string;
  readonly value: string;
  readonly enabled: boolean;
  readonly description?: string;
  readonly mode?: "override" | "append";
}

/** Describes an immutable workspace upload referenced by a request body. */
export interface RequestAttachment {
  readonly attachmentId: string;
  readonly workspaceId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/** Describes one file positioned among multipart text fields. */
export interface MultipartFileField {
  readonly kind: "file";
  readonly name: string;
  readonly enabled: boolean;
  readonly description?: string;
  readonly attachment: RequestAttachment;
}

/** Preserves the canonical HTTP wire-body forms exchanged with content plugins. */
export type RequestBodyDefinition =
  | { readonly kind: "none" }
  | {
      readonly kind: "text";
      readonly contentType: string | null;
      readonly text: string;
    }
  | {
      readonly kind: "file";
      readonly contentType: string | null;
      readonly attachment: RequestAttachment;
    }
  | {
      readonly kind: "urlencoded";
      readonly contentType: string | null;
      readonly fields: RequestBodyField[];
    }
  | {
      readonly kind: "multipart";
      readonly contentType: string | null;
      readonly boundary: string;
      readonly fields: (RequestBodyField | MultipartFileField)[];
    };

/** Identifies the declaration that supplied one effective variable preview. */
export interface VariablePreviewSource {
  readonly scope: "workspace" | "collection" | "environment" | "request";
  readonly scopeId: string;
  readonly scopeName: string;
  readonly revision: number;
}

/** Provides secret-safe variable resolution evidence to an editor plugin. */
export interface VariablePreview {
  readonly name: string;
  readonly status: "resolved" | "missing" | "unset" | "error";
  readonly declaredKind: "value" | "secret" | "alias" | "unset" | null;
  readonly effectiveKind: "value" | "secret" | null;
  readonly aliasTarget: string | null;
  readonly value: string | null;
  readonly secretVersion: number | null;
  readonly diagnostic: string | null;
  readonly source: VariablePreviewSource | null;
}

/** Exposes only response fields required by response-content plugins. */
export interface ResponseExecution {
  readonly executionId: string;
  readonly headers?: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly bodyComplete: boolean;
  readonly bodyBytes?: number;
  readonly bodyPreview?: string;
  readonly bodyBlobId?: string;
}
/** Names one editor language understood by a host or safely treated as plain text. */
export type CodeEditorLanguage = string;

/** Supplies a stable fallback and optional translations owned by the plugin package. */
export interface PluginLabel {
  readonly default: string;
  readonly translations?: Readonly<Record<string, string>>;
}

/** Returns either formatted request source or a safe user-facing parse error. */
export type RequestContentFormatResult =
  | { readonly valid: true; readonly value: string }
  | { readonly valid: false; readonly error: string };

/** Updates or destroys one framework-neutral plugin view instance. */
export interface FrontendPluginViewHandle<TContext> {
  update(context: TContext): void;
  destroy(): void;
}

/** Mounts one plugin-owned view into a host-provided DOM container. */
export type FrontendPluginViewMount<TContext> = (
  container: HTMLElement,
  context: TContext,
) => FrontendPluginViewHandle<TContext>;

/** Configures the shared CodeMirror mechanism without choosing content semantics. */
export interface CodeEditorMountOptions {
  readonly document: string;
  readonly label: string;
  readonly language?: CodeEditorLanguage;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly foldable?: boolean;
  readonly onChange?: (document: string) => void;
}

/** Configures the generic editor for canonical HTTP wire-body representations. */
export interface WireBodyEditorMountOptions {
  readonly body: RequestBodyDefinition;
  readonly wireKind: RequestBodyHostKind;
  readonly label: string;
  readonly disabled: boolean;
  readonly variablePreviews: readonly VariablePreview[];
  readonly uploadAttachment?: (file: File) => Promise<RequestAttachment>;
  readonly codeLanguage?: CodeEditorLanguage;
  readonly contentTypePlaceholder?: string;
  readonly format?: (source: string) => RequestContentFormatResult;
  readonly onChange: (body: RequestBodyDefinition) => void;
}

/** Configures an isolated document surface for untrusted response markup. */
export interface SandboxedDocumentMountOptions {
  readonly source: string;
  readonly title: string;
}

/** Configures bounded raster decoding through host-owned security policy. */
export interface ImageViewerMountOptions {
  readonly executionId: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly loadBody: (executionId: string) => Promise<Blob>;
  /** Interprets bounded header bytes without moving format knowledge into the host. */
  readonly inspect: (
    mediaType: string,
    bytes: Uint8Array,
  ) => ImageDimensions | null;
}

/** Describes intrinsic raster dimensions returned by a plugin-owned inspector. */
export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/** Exposes reusable UI and security mechanisms without application internals. */
export interface FrontendPluginUi {
  mountCodeEditor(
    container: HTMLElement,
    options: CodeEditorMountOptions,
  ): FrontendPluginViewHandle<CodeEditorMountOptions>;
  mountWireBodyEditor(
    container: HTMLElement,
    options: WireBodyEditorMountOptions,
  ): FrontendPluginViewHandle<WireBodyEditorMountOptions>;
  mountSandboxedDocument(
    container: HTMLElement,
    options: SandboxedDocumentMountOptions,
  ): FrontendPluginViewHandle<SandboxedDocumentMountOptions>;
  mountImageViewer(
    container: HTMLElement,
    options: ImageViewerMountOptions,
  ): FrontendPluginViewHandle<ImageViewerMountOptions>;
}

/** Supplies canonical wire state and host mechanisms to a request editor. */
export interface RequestContentEditorContext {
  readonly body: RequestBodyDefinition;
  readonly disabled: boolean;
  readonly locale: string;
  readonly variablePreviews: readonly VariablePreview[];
  readonly uploadAttachment?: (file: File) => Promise<RequestAttachment>;
  readonly updateBody: (body: RequestBodyDefinition) => void;
  readonly ui: FrontendPluginUi;
}

/** Contributes executable request editing over a canonical HTTP wire body. */
export interface RequestContentContribution {
  readonly id: string;
  readonly label: PluginLabel;
  readonly mediaTypes?: readonly string[];
  readonly priority?: number;
  readonly order?: number;
  createBody(previous: RequestBodyDefinition): RequestBodyDefinition;
  isDefaultFor(body: RequestBodyDefinition): boolean;
  effectiveContentType(body: RequestBodyDefinition): string | null;
  mountEditor: FrontendPluginViewMount<RequestContentEditorContext>;
}

/** Provides bounded response data to one selected frontend parser/presenter. */
export interface ResponseContentPresenterContext {
  readonly execution: ResponseExecution;
  readonly mediaType: string;
  readonly locale: string;
  readonly previewComplete: boolean;
  readonly previewTruncated: boolean;
  readonly loadBody?: (executionId: string) => Promise<Blob>;
  readonly ui: FrontendPluginUi;
}

/** Contributes one executable response viewer for deterministic media-type patterns. */
export interface ResponseContentContribution {
  readonly id: string;
  readonly label: PluginLabel;
  readonly mediaTypes: readonly string[];
  readonly priority?: number;
  isAvailable?(context: Omit<ResponseContentPresenterContext, "ui">): boolean;
  isDefault?(context: Omit<ResponseContentPresenterContext, "ui">): boolean;
  mountView: FrontendPluginViewMount<ResponseContentPresenterContext>;
}

/** Lists the extension providers available to frontend-only plugins. */
export interface FrontendPluginProviders {
  readonly "request.content": RequestContentContribution;
  readonly "response.content": ResponseContentContribution;
}

export type FrontendPluginModule =
  APInteractPluginModule<FrontendPluginProviders>;
