import { createHash, type Hash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  type ReadStream,
  type WriteStream,
} from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { once } from "node:events";

import { createEntityId, type EntityId } from "../foundation/id.js";

const PREVIEW_LIMIT_BYTES = 256 * 1024;

/** Metadata returned after staged bytes become an immutable local blob. */
export interface StoredBlob {
  readonly id: EntityId;
  readonly storageKey: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly previewBytes: Buffer;
}

/**
 * Single-use streaming writer for the local blob provider.
 *
 * Bytes are hashed and staged while they arrive. The writer must finish in
 * exactly one state: committed by atomic rename, or aborted with staging data
 * removed. The bounded preview is diagnostic metadata, not a second body copy.
 */
export class LocalBlobWriter {
  readonly #id: EntityId;
  readonly #stagingPath: string;
  readonly #rootPath: string;
  readonly #stream: WriteStream;
  readonly #hash: Hash = createHash("sha256");
  readonly #preview: Buffer[] = [];
  #previewLength = 0;
  #byteLength = 0;
  #closed = false;

  constructor(id: EntityId, stagingPath: string, rootPath: string) {
    this.#id = id;
    this.#stagingPath = stagingPath;
    this.#rootPath = rootPath;
    this.#stream = createWriteStream(stagingPath, {
      flags: "wx",
      mode: 0o600,
    });
  }

  /** Reports the number of unmodified bytes accepted by this writer. */
  get byteLength(): number {
    return this.#byteLength;
  }

  /** Appends bytes while updating the digest, preview, and backpressure state. */
  async write(bytes: Buffer): Promise<void> {
    if (this.#closed) {
      throw new Error("Blob writer is already closed");
    }
    this.#byteLength += bytes.byteLength;
    this.#hash.update(bytes);
    if (this.#previewLength < PREVIEW_LIMIT_BYTES) {
      const remaining = PREVIEW_LIMIT_BYTES - this.#previewLength;
      const part = bytes.subarray(0, remaining);
      this.#preview.push(Buffer.from(part));
      this.#previewLength += part.byteLength;
    }
    // Respect filesystem backpressure so a large response cannot be buffered
    // indefinitely in process memory.
    if (!this.#stream.write(bytes)) {
      await once(this.#stream, "drain");
    }
  }

  /** Atomically promotes staged bytes to an immutable local blob. */
  async commit(): Promise<StoredBlob> {
    if (this.#closed) {
      throw new Error("Blob writer is already closed");
    }
    this.#closed = true;
    this.#stream.end();
    await once(this.#stream, "close");
    const storageKey = join(this.#id.slice(0, 2), this.#id);
    const destination = join(this.#rootPath, storageKey);
    await mkdir(dirname(destination), { recursive: true });
    // Staging and destination paths must share a filesystem so rename provides
    // an atomic transition from incomplete to immutable provider data.
    await rename(this.#stagingPath, destination);
    return {
      id: this.#id,
      storageKey,
      byteLength: this.#byteLength,
      sha256: this.#hash.digest("hex"),
      previewBytes: Buffer.concat(this.#preview),
    };
  }

  /** Terminates an incomplete write and removes its staging file. */
  async abort(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#stream.destroy();
    }
    await rm(this.#stagingPath, { force: true });
  }
}

/**
 * Filesystem implementation of blob storage.
 *
 * This provider owns byte persistence only. Database metadata, references, and
 * orphan recovery remain responsibilities of backend orchestration.
 */
export class LocalBlobStore {
  readonly #rootPath: string;
  readonly #stagingPath: string;

  constructor(rootPath: string, stagingPath: string) {
    this.#rootPath = rootPath;
    this.#stagingPath = stagingPath;
  }

  /** Creates the provider's immutable and staging directories. */
  async initialize(): Promise<void> {
    await mkdir(this.#rootPath, { recursive: true });
    await mkdir(this.#stagingPath, { recursive: true });
  }

  /** Creates a single-use writer with a new opaque blob identifier. */
  createWriter(): LocalBlobWriter {
    const id = createEntityId();
    const path = join(this.#stagingPath, `${id}.part`);
    return new LocalBlobWriter(id, path, this.#rootPath);
  }

  /** Opens an immutable blob as a filesystem read stream. */
  open(storageKey: string): ReadStream {
    return createReadStream(join(this.#rootPath, storageKey));
  }
}
