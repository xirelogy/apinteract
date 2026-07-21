import { v4 as uuidV4 } from "uuid";
import { describe, expect, it } from "vitest";

import { bytesToId, createEntityId, idToBytes } from "../src/foundation/id.js";

describe("entity identifiers", () => {
  it("round-trips a canonical UUIDv7 through its binary representation", () => {
    const id = createEntityId();
    const bytes = idToBytes(id);

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(bytes).toHaveLength(16);
    expect(bytesToId(bytes)).toBe(id);
  });

  it("rejects non-v7 and non-canonical public identifiers", () => {
    const id = createEntityId();

    expect(() => idToBytes(uuidV4())).toThrow(
      "Expected a canonical lowercase UUIDv7",
    );
    expect(() => idToBytes(id.toUpperCase())).toThrow(
      "Expected a canonical lowercase UUIDv7",
    );
  });

  it("rejects persisted identifiers with an invalid byte length", () => {
    expect(() => bytesToId(new Uint8Array(15))).toThrow(
      "Persisted entity ID must contain exactly 16 bytes",
    );
  });
});
