import { describe, expect, it } from "vitest";

import { readImageDimensions } from "../src/model/domain/image-dimensions";

/** Writes a short ASCII signature into test image bytes. */
function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

describe("image dimension inspection", () => {
  it("reads PNG, GIF, and BMP dimensions from validated headers", () => {
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    writeAscii(png, 12, "IHDR");
    new DataView(png.buffer).setUint32(16, 640);
    new DataView(png.buffer).setUint32(20, 480);
    expect(readImageDimensions("image/png", png)).toEqual({
      width: 640,
      height: 480,
    });

    const gif = new Uint8Array(10);
    writeAscii(gif, 0, "GIF89a");
    new DataView(gif.buffer).setUint16(6, 320, true);
    new DataView(gif.buffer).setUint16(8, 200, true);
    expect(readImageDimensions("image/gif", gif)).toEqual({
      width: 320,
      height: 200,
    });

    const bmp = new Uint8Array(26);
    writeAscii(bmp, 0, "BM");
    const bmpView = new DataView(bmp.buffer);
    bmpView.setUint32(14, 40, true);
    bmpView.setInt32(18, 800, true);
    bmpView.setInt32(22, -600, true);
    expect(readImageDimensions("image/bmp", bmp)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("walks JPEG frame segments and reads WebP extended dimensions", () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x07,
      0x08, 0x01, 0x2c, 0x02, 0x58,
    ]);
    expect(readImageDimensions("image/jpeg", jpeg)).toEqual({
      width: 600,
      height: 300,
    });

    const webp = new Uint8Array(30);
    writeAscii(webp, 0, "RIFF");
    writeAscii(webp, 8, "WEBP");
    writeAscii(webp, 12, "VP8X");
    webp.set([0xff, 0x03, 0x00], 24);
    webp.set([0xdf, 0x01, 0x00], 27);
    expect(readImageDimensions("image/webp", webp)).toEqual({
      width: 1024,
      height: 480,
    });
  });

  it("uses the largest ICO canvas and rejects mismatched signatures", () => {
    const icon = new Uint8Array(38);
    const view = new DataView(icon.buffer);
    view.setUint16(2, 1, true);
    view.setUint16(4, 2, true);
    icon[6] = 32;
    icon[7] = 32;
    icon[22] = 0;
    icon[23] = 0;
    expect(readImageDimensions("image/x-icon", icon)).toEqual({
      width: 256,
      height: 256,
    });
    expect(readImageDimensions("image/png", new Uint8Array(24))).toBeNull();
    expect(readImageDimensions("image/avif", icon)).toBeNull();
  });
});
