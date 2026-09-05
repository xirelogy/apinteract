import { open, rm, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

export const FRAME_HEADER_BYTES = 16;
export const MAX_FRAME_PAYLOAD_BYTES = 1_048_576;

/**
 * Stable frame type values used by version 1 of the proxy response stream.
 *
 * These numeric values are part of the wire contract and must not be reordered.
 */
export enum FrameType {
  ResponseHead = 1,
  Body = 2,
  Trailers = 3,
  Complete = 4,
  Error = 5,
  Heartbeat = 6,
}

interface FrameLocation {
  readonly sequence: number;
  readonly offset: number;
  readonly length: number;
}

/**
 * Append-only, file-backed replay cache for one proxy execution.
 *
 * Frames remain readable by sequence number until the owning execution is
 * released. Writers may append exactly one terminal frame; readers wait for
 * new data until that frame is available.
 */
export class FrameStore {
  readonly #path: string;
  readonly #handle: FileHandle;
  readonly #frames: FrameLocation[] = [];
  readonly #waiters = new Set<() => void>();
  #writeOffset = 0;
  #terminal = false;

  private constructor(path: string, handle: FileHandle) {
    this.#path = path;
    this.#handle = handle;
  }

  /** Creates an empty frame cache and its parent directory. */
  static async create(path: string): Promise<FrameStore> {
    await mkdir(dirname(path), { recursive: true });
    return new FrameStore(path, await open(path, "w+"));
  }

  /** Reports whether the stream has accepted its single terminal frame. */
  get terminal(): boolean {
    return this.#terminal;
  }

  /** Serializes and appends a JSON metadata frame. */
  async appendJson(
    type: FrameType,
    value: unknown,
    terminal = false,
  ): Promise<number> {
    return this.append(type, Buffer.from(JSON.stringify(value)), terminal);
  }

  /** Encodes and persists one ordered version 1 response frame. */
  async append(
    type: FrameType,
    payload: Buffer,
    terminal = false,
  ): Promise<number> {
    if (this.#terminal) {
      throw new Error("Cannot append a frame after a terminal frame");
    }
    if (payload.byteLength > MAX_FRAME_PAYLOAD_BYTES) {
      throw new Error("Frame payload exceeds the protocol limit");
    }

    const sequence = this.#frames.length;
    const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
    // V1 header: type[1], flags[1], reserved[2], sequence[4],
    // payload length[8], followed by the payload without transformation.
    frame.writeUInt8(type, 0);
    frame.writeUInt8(0, 1);
    frame.writeUInt16BE(0, 2);
    frame.writeUInt32BE(sequence, 4);
    frame.writeBigUInt64BE(BigInt(payload.byteLength), 8);
    payload.copy(frame, FRAME_HEADER_BYTES);

    const offset = this.#writeOffset;
    await this.#handle.write(frame, 0, frame.byteLength, offset);
    this.#writeOffset += frame.byteLength;
    this.#frames.push({ sequence, offset, length: frame.byteLength });
    this.#terminal = terminal;
    this.#notifyWaiters();
    return sequence;
  }

  /** Replays frames after a sequence and waits until terminal when caught up. */
  async *readAfter(
    afterSequence: number,
    signal?: AbortSignal,
  ): AsyncGenerator<Buffer> {
    // A caller resumes after its last complete frame. Passing -1 starts at the
    // first frame, while a caught-up reader waits without polling.
    let index = afterSequence + 1;
    while (true) {
      if (signal?.aborted === true) return;
      const frame = this.#frames[index];
      if (frame !== undefined) {
        const bytes = Buffer.allocUnsafe(frame.length);
        await this.#handle.read(bytes, 0, frame.length, frame.offset);
        index += 1;
        yield bytes;
        continue;
      }
      if (this.#terminal) {
        return;
      }
      await this.#waitForFrame(signal);
    }
  }

  /** Wakes readers, closes the cache, and removes its backing file. */
  async dispose(): Promise<void> {
    // Wake blocked readers before closing and unlinking the backing file.
    this.#terminal = true;
    this.#notifyWaiters();
    await this.#handle.close();
    await rm(this.#path, { force: true });
  }

  /** Suspends a caught-up reader until append or disposal changes state. */
  #waitForFrame(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      /** Removes both wake paths before resuming the reader. */
      const wake = () => {
        if (settled) return;
        settled = true;
        this.#waiters.delete(wake);
        signal?.removeEventListener("abort", wake);
        resolve();
      };
      this.#waiters.add(wake);
      signal?.addEventListener("abort", wake, { once: true });
      if (signal?.aborted === true) wake();
    });
  }

  /** Wakes all readers waiting for a new frame or terminal transition. */
  #notifyWaiters(): void {
    for (const resolve of this.#waiters) {
      resolve();
    }
    this.#waiters.clear();
  }
}
