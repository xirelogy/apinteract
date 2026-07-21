import { parse, stringify, v7 as uuidV7, validate, version } from "uuid";

export type EntityId = string;

/** Creates a time-sortable canonical UUIDv7 entity identifier. */
export function createEntityId(): EntityId {
  return uuidV7();
}

/** Validates and converts a canonical UUIDv7 identifier to database bytes. */
export function idToBytes(id: EntityId): Uint8Array {
  if (!validate(id) || version(id) !== 7 || id !== id.toLowerCase()) {
    throw new Error("Expected a canonical lowercase UUIDv7");
  }
  return Uint8Array.from(parse(id));
}

/** Converts a persisted 16-byte UUIDv7 representation to its canonical text. */
export function bytesToId(bytes: Uint8Array): EntityId {
  if (bytes.byteLength !== 16) {
    throw new Error("Persisted entity ID must contain exactly 16 bytes");
  }
  const id = stringify(bytes);
  if (version(id) !== 7) {
    throw new Error("Persisted entity ID is not UUIDv7");
  }
  return id;
}
