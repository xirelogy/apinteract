import { describe, expect, it } from "vitest";

import {
  MediaTypeRegistry,
  normalizeMediaType,
} from "../src/model/domain/media-types";

describe("media type registry", () => {
  it("normalizes declared values and rejects malformed input", () => {
    expect(
      normalizeMediaType(" Application/Problem+JSON ; charset=utf-8"),
    ).toBe("application/problem+json");
    expect(normalizeMediaType("not a media type")).toBeNull();
    expect(normalizeMediaType(null)).toBeNull();
  });

  it("prefers exact, suffix, type, and universal matches in that order", () => {
    const registry = new MediaTypeRegistry<string>();
    registry.register({ id: "any", patterns: ["*/*"], value: "any" });
    registry.register({ id: "text", patterns: ["text/*"], value: "text" });
    registry.register({ id: "json", patterns: ["*+json"], value: "json" });
    registry.register({
      id: "problem",
      patterns: ["application/problem+json"],
      value: "problem",
    });

    expect(registry.resolve("application/problem+json")).toBe("problem");
    expect(registry.resolve("application/activity+json")).toBe("json");
    expect(registry.resolve("text/plain")).toBe("text");
    expect(registry.resolve("image/png")).toBe("any");
  });

  it("uses priority for deliberate overrides and rejects ambiguous patterns", () => {
    const registry = new MediaTypeRegistry<string>();
    registry.register({
      id: "builtin",
      patterns: ["application/json"],
      value: "builtin",
    });
    registry.register({
      id: "override",
      patterns: ["application/json"],
      priority: 10,
      value: "override",
    });
    expect(registry.resolve("application/json")).toBe("override");

    expect(() =>
      registry.register({
        id: "conflict",
        patterns: ["application/json"],
        value: "conflict",
      }),
    ).toThrow(/conflicts/u);
    expect(() =>
      registry.register({ id: "invalid", patterns: ["json"], value: "bad" }),
    ).toThrow(/Invalid media-type pattern/u);
  });
});
