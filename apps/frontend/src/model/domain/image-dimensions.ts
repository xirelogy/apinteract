export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/** Reads trusted dimensions from the bounded header bytes of a supported image. */
export function readImageDimensions(
  mediaType: string,
  bytes: Uint8Array,
): ImageDimensions | null {
  if (mediaType === "image/png") return pngDimensions(bytes);
  if (mediaType === "image/gif") return gifDimensions(bytes);
  if (mediaType === "image/jpeg") return jpegDimensions(bytes);
  if (mediaType === "image/webp") return webpDimensions(bytes);
  if (mediaType === "image/bmp") return bmpDimensions(bytes);
  if (
    mediaType === "image/x-icon" ||
    mediaType === "image/vnd.microsoft.icon"
  ) {
    return iconDimensions(bytes);
  }
  return null;
}

/** Reads PNG IHDR dimensions after checking its signature and fixed header. */
function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length < 24 ||
    signature.some((value, index) => bytes[index] !== value) ||
    ascii(bytes, 12, 4) !== "IHDR"
  ) {
    return null;
  }
  const view = dataView(bytes);
  return dimensions(view.getUint32(16), view.getUint32(20));
}

/** Reads GIF logical-screen dimensions from its fixed header. */
function gifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10 || !["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) {
    return null;
  }
  const view = dataView(bytes);
  return dimensions(view.getUint16(6, true), view.getUint16(8, true));
}

/** Walks bounded JPEG segments until a frame reports intrinsic dimensions. */
function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = dataView(bytes);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (isJpegStartOfFrame(marker) && length >= 7) {
      return dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
    }
    offset += length;
  }
  return null;
}

/** Reports whether one JPEG marker carries a frame header. */
function isJpegStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
  );
}

/** Reads the canvas dimensions from the three WebP bitstream variants. */
function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.length < 30 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) {
    return null;
  }
  const kind = ascii(bytes, 12, 4);
  if (kind === "VP8X") {
    return dimensions(
      1 + uint24LittleEndian(bytes, 24),
      1 + uint24LittleEndian(bytes, 27),
    );
  }
  if (kind === "VP8L" && bytes[20] === 0x2f) {
    return dimensions(
      1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8),
      1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10),
    );
  }
  if (
    kind === "VP8 " &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    const view = dataView(bytes);
    return dimensions(
      view.getUint16(26, true) & 0x3fff,
      view.getUint16(28, true) & 0x3fff,
    );
  }
  return null;
}

/** Reads common Windows bitmap dimensions from its DIB header. */
function bmpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 26 || ascii(bytes, 0, 2) !== "BM") return null;
  const view = dataView(bytes);
  const dibSize = view.getUint32(14, true);
  if (dibSize === 12) {
    return dimensions(view.getUint16(18, true), view.getUint16(20, true));
  }
  if (dibSize < 40 || bytes.length < 26) return null;
  return dimensions(
    Math.abs(view.getInt32(18, true)),
    Math.abs(view.getInt32(22, true)),
  );
}

/** Returns the largest declared icon-directory canvas. */
function iconDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 6) return null;
  const view = dataView(bytes);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) {
    return null;
  }
  const count = view.getUint16(4, true);
  if (count === 0 || bytes.length < 6 + count * 16) return null;
  let width = 0;
  let height = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    width = Math.max(width, bytes[offset] === 0 ? 256 : bytes[offset]!);
    height = Math.max(
      height,
      bytes[offset + 1] === 0 ? 256 : bytes[offset + 1]!,
    );
  }
  return dimensions(width, height);
}

/** Creates a DataView over the exact Uint8Array window. */
function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Reads a short ASCII signature without invoking a text decoder. */
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let result = "";
  for (let index = offset; index < offset + length; index += 1) {
    result += String.fromCharCode(bytes[index] ?? 0);
  }
  return result;
}

/** Reads one unsigned 24-bit little-endian integer. */
function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16)
  );
}

/** Rejects missing, zero, and non-safe dimensions at the parser boundary. */
function dimensions(width: number, height: number): ImageDimensions | null {
  return Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0
    ? { width, height }
    : null;
}
