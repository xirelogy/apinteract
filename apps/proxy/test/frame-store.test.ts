import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FrameStore, FrameType } from "../src/protocol/frame-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("FrameStore", () => {
  it("replays complete ordered frames after a sequence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "apinteract-frame-test-"));
    temporaryDirectories.push(directory);
    const store = await FrameStore.create(join(directory, "frames"));
    await store.appendJson(FrameType.ResponseHead, { status: 200 });
    await store.append(FrameType.Body, Buffer.from("body"));
    await store.appendJson(FrameType.Complete, { bodyBytes: 4 }, true);

    const frames: Buffer[] = [];
    for await (const frame of store.readAfter(0)) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(frames[0]?.readUInt32BE(4)).toBe(1);
    expect(frames[0]?.subarray(16).toString()).toBe("body");
    expect(frames[1]?.readUInt32BE(4)).toBe(2);
    await store.dispose();
  });

  it("stops a waiting reader when its client disconnects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "apinteract-frame-test-"));
    temporaryDirectories.push(directory);
    const store = await FrameStore.create(join(directory, "frames"));
    const controller = new AbortController();
    const reader = store.readAfter(-1, controller.signal);
    const pending = reader.next();

    controller.abort();

    await expect(pending).resolves.toMatchObject({ done: true });
    await store.dispose();
  });
});
