import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readImageDimensions } from "../src/image-dimensions.ts";

/** Writes a short ASCII signature into test image bytes. */
function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

void describe("image dimension inspection", () => {
  void it("reads PNG, GIF, and BMP dimensions from validated headers", () => {
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    writeAscii(png, 12, "IHDR");
    new DataView(png.buffer).setUint32(16, 640);
    new DataView(png.buffer).setUint32(20, 480);
    assert.deepEqual(readImageDimensions("image/png", png), {
      width: 640,
      height: 480,
    });

    const gif = new Uint8Array(10);
    writeAscii(gif, 0, "GIF89a");
    new DataView(gif.buffer).setUint16(6, 320, true);
    new DataView(gif.buffer).setUint16(8, 200, true);
    assert.deepEqual(readImageDimensions("image/gif", gif), {
      width: 320,
      height: 200,
    });

    const bmp = new Uint8Array(26);
    writeAscii(bmp, 0, "BM");
    const bmpView = new DataView(bmp.buffer);
    bmpView.setUint32(14, 40, true);
    bmpView.setInt32(18, 800, true);
    bmpView.setInt32(22, -600, true);
    assert.deepEqual(readImageDimensions("image/bmp", bmp), {
      width: 800,
      height: 600,
    });
  });

  void it("walks JPEG frame segments and reads WebP extended dimensions", () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x07,
      0x08, 0x01, 0x2c, 0x02, 0x58,
    ]);
    assert.deepEqual(readImageDimensions("image/jpeg", jpeg), {
      width: 600,
      height: 300,
    });

    const webp = new Uint8Array(30);
    writeAscii(webp, 0, "RIFF");
    writeAscii(webp, 8, "WEBP");
    writeAscii(webp, 12, "VP8X");
    webp.set([0xff, 0x03, 0x00], 24);
    webp.set([0xdf, 0x01, 0x00], 27);
    assert.deepEqual(readImageDimensions("image/webp", webp), {
      width: 1024,
      height: 480,
    });
  });

  void it("uses the largest ICO canvas and rejects mismatched signatures", () => {
    const icon = new Uint8Array(38);
    const view = new DataView(icon.buffer);
    view.setUint16(2, 1, true);
    view.setUint16(4, 2, true);
    icon[6] = 32;
    icon[7] = 32;
    icon[22] = 0;
    icon[23] = 0;
    assert.deepEqual(readImageDimensions("image/x-icon", icon), {
      width: 256,
      height: 256,
    });
    assert.equal(readImageDimensions("image/png", new Uint8Array(24)), null);
    assert.equal(readImageDimensions("image/avif", icon), null);
  });
});
