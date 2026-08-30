import type {
  RequestBodyHostKind,
  RequestContentContribution,
  RequestContentFormatResult,
} from "@apinteract/plugin-api/frontend";

import type { RequestBodyDefinition } from "@/model/contracts/backend";
import { MediaTypeRegistry } from "@/model/domain/media-types";

export type RequestBodyPreset = RequestContentContribution;

/** Owns request presets while keeping wire-level body kinds authoritative. */
export class RequestBodyPresetRegistry {
  readonly #presets = new Map<string, RequestBodyPreset>();
  readonly #mediaTypes = new MediaTypeRegistry<RequestBodyPreset>();

  /** Registers one preset backed by an existing host editor primitive. */
  register(preset: RequestBodyPreset): void {
    const id = preset.id.trim();
    if (id === "" || this.#presets.has(id)) {
      throw new Error(
        `Request body preset ID is invalid or already used: ${id}`,
      );
    }
    if (preset.label.default.trim() === "") {
      throw new Error(`Request body preset label is required: ${id}`);
    }
    if (preset.bodyKind === "text" && preset.textLanguage === undefined) {
      throw new Error(`Text request body preset requires a language: ${id}`);
    }
    if (preset.bodyKind !== "text" && preset.textLanguage !== undefined) {
      throw new Error(
        `Only text request body presets accept a language: ${id}`,
      );
    }
    if (preset.bodyKind !== "text" && preset.format !== undefined) {
      throw new Error(
        `Only text request body presets accept a formatter: ${id}`,
      );
    }
    if (
      preset.defaultForBodyKind === true &&
      [...this.#presets.values()].some(
        (candidate) =>
          candidate.bodyKind === preset.bodyKind &&
          candidate.defaultForBodyKind === true,
      )
    ) {
      throw new Error(
        `Request body kind already has a default preset: ${preset.bodyKind}`,
      );
    }
    const registered = Object.freeze({ ...preset, id });
    if ((preset.mediaTypes?.length ?? 0) > 0) {
      this.#mediaTypes.register({
        id,
        patterns: preset.mediaTypes ?? [],
        ...(preset.priority === undefined ? {} : { priority: preset.priority }),
        value: registered,
      });
    }
    this.#presets.set(id, registered);
  }

  /** Returns all presets in stable registration order for presentation. */
  list(): readonly RequestBodyPreset[] {
    return [...this.#presets.values()];
  }

  /** Returns one preset by its stable identifier. */
  get(id: string): RequestBodyPreset | undefined {
    return this.#presets.get(id);
  }

  /** Requires a known preset at an internal component boundary. */
  require(id: string): RequestBodyPreset {
    const preset = this.get(id);
    if (preset === undefined)
      throw new Error(`Unknown request body preset: ${id}`);
    return preset;
  }

  /** Returns the required fallback preset for one wire-level body kind. */
  defaultFor(bodyKind: RequestBodyHostKind): RequestBodyPreset {
    const preset = [...this.#presets.values()].find(
      (candidate) =>
        candidate.bodyKind === bodyKind &&
        candidate.defaultForBodyKind === true,
    );
    if (preset === undefined) {
      throw new Error(`Request body kind has no default preset: ${bodyKind}`);
    }
    return preset;
  }

  /** Selects the most specific preset for a persisted semantic body. */
  resolveBody(body: RequestBodyDefinition): RequestBodyPreset {
    if (body.kind === "text") {
      const matched = this.#mediaTypes.resolve(body.contentType);
      if (matched !== undefined) return matched;
    }
    return this.defaultFor(body.kind);
  }

  /** Formats text through the selected contribution when it exposes a parser. */
  format(id: string, source: string): RequestContentFormatResult | undefined {
    return this.require(id).format?.(source);
  }
}
