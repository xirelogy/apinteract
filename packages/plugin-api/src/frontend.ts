import type { components } from "@apinteract/api-contracts/backend";

import type { APInteractPlugin } from "./core.js";

export type RequestBodyHostKind =
  components["schemas"]["RequestBodyDefinition"]["kind"];
export type RequestBodyTextLanguage = "plain" | "json";
export type ResponseContentKind =
  | "empty"
  | "text"
  | "json"
  | "xml"
  | "html"
  | "image"
  | "binary"
  | "unavailable";

/** Supplies a stable fallback while allowing host-owned translations. */
export interface PluginLabel {
  readonly default: string;
  readonly translationKey?: string;
}

/** Returns either formatted request source or a safe user-facing parse error. */
export type RequestContentFormatResult =
  | { readonly valid: true; readonly value: string }
  | { readonly valid: false; readonly error: string };

/** Contributes one request body presentation backed by a host editor primitive. */
export interface RequestContentContribution {
  readonly id: string;
  readonly label: PluginLabel;
  readonly bodyKind: RequestBodyHostKind;
  readonly defaultContentType: string | null;
  readonly mediaTypes?: readonly string[];
  readonly priority?: number;
  readonly textLanguage?: RequestBodyTextLanguage;
  readonly defaultForBodyKind?: boolean;
  format?(source: string): RequestContentFormatResult;
}

/** Preserves exact source beside a structured, validated response projection. */
export interface StructuredResponseView {
  readonly language: "json" | "xml";
  readonly value?: string;
  readonly valid: boolean;
}

/** Provides bounded response data to one selected frontend parser/presenter. */
export interface ResponseContentPresenterContext {
  readonly execution: components["schemas"]["ExecutionView"];
  readonly mediaType: string;
  readonly previewComplete: boolean;
  readonly previewTruncated: boolean;
}

/** Describes the host presentation selected for a response body. */
export interface ResponseContentPresentation {
  readonly kind: ResponseContentKind;
  readonly structured?: StructuredResponseView;
}

/** Contributes one response parser/presenter for deterministic media-type patterns. */
export interface ResponseContentContribution {
  readonly id: string;
  readonly mediaTypes: readonly string[];
  readonly priority?: number;
  present(
    context: ResponseContentPresenterContext,
  ): ResponseContentPresentation;
}

/** Lists the extension providers available to frontend-only plugins. */
export interface FrontendPluginProviders {
  readonly "request.content": RequestContentContribution;
  readonly "response.content": ResponseContentContribution;
}

export type FrontendPlugin = APInteractPlugin<
  "frontend",
  FrontendPluginProviders
>;
