import type { RequestContentContribution } from "@apinteract/plugin-api/frontend";

import type { RequestBodyDefinition } from "@/model/contracts/backend";
import { MediaTypeRegistry } from "@/model/domain/media-types";

export type RequestBodyPreset = RequestContentContribution;

/** Owns request presets while keeping wire-level body kinds authoritative. */
export class RequestBodyPresetRegistry {
  readonly #presets = new Map<string, RequestBodyPreset>();
  readonly #weights = new Map<string, number>();
  readonly #mediaTypes = new MediaTypeRegistry<RequestBodyPreset>();

  /** Registers one preset backed by an existing host editor primitive. */
  register(
    preset: RequestBodyPreset,
    ownerId = "host",
    pluginWeight = 0,
  ): void {
    const localId = preset.id.trim();
    const id = `${ownerId}/${localId}`;
    if (localId === "" || localId.includes("/") || this.#presets.has(id)) {
      throw new Error(
        `Request body preset ID is invalid or already used: ${id}`,
      );
    }
    if (preset.label.default.trim() === "") {
      throw new Error(`Request body preset label is required: ${id}`);
    }
    if (preset.order !== undefined && !Number.isSafeInteger(preset.order)) {
      throw new Error(`Request body preset order must be an integer: ${id}`);
    }
    if (
      !Number.isSafeInteger(pluginWeight) ||
      pluginWeight < -10000 ||
      pluginWeight > 10000
    ) {
      throw new Error(`Request body preset plugin weight is invalid: ${id}`);
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
    this.#weights.set(id, pluginWeight);
  }

  /** Returns all presets in stable registration order for presentation. */
  list(): readonly RequestBodyPreset[] {
    return [...this.#presets.values()].sort(
      (left, right) =>
        (this.#weights.get(right.id) ?? 0) -
          (this.#weights.get(left.id) ?? 0) ||
        (left.order ?? 1000) - (right.order ?? 1000),
    );
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

  /** Selects the most specific preset for a persisted semantic body. */
  resolveBody(body: RequestBodyDefinition): RequestBodyPreset {
    if (body.kind === "text") {
      const matched = this.#mediaTypes.resolve(body.contentType);
      if (matched !== undefined) return matched;
    }
    const fallback = [...this.#presets.values()].find((candidate) =>
      candidate.isDefaultFor(body),
    );
    if (fallback === undefined) {
      throw new Error(`Request body has no default plugin: ${body.kind}`);
    }
    return fallback;
  }
}
