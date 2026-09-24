import { ApiError } from "./security";

const MAX_DECODED = 5 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;

function invalid(): never {
  throw new ApiError(422, "invalid_image", "Send static PNG, JPEG, or WebP images as base64 data URLs.");
}

function u32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0);
}

function pngCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dimensions(bytes: Uint8Array, mime: string): [number, number] {
  if (mime === "image/png") {
    if (bytes.length < 33 || ![137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n) ||
        String.fromCharCode(...bytes.slice(12,16)) !== "IHDR") invalid();
    let offset = 8;
    let ended = false;
    let imageData = false;
    while (offset + 12 <= bytes.length) {
      const size = u32(bytes, offset);
      if (size > bytes.length - offset - 12) invalid();
      const tag = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
      if (pngCrc(bytes, offset + 4, offset + 8 + size) !== u32(bytes, offset + 8 + size)) invalid();
      if (tag === "acTL") invalid();
      if (tag === "IDAT") imageData = true;
      if (tag === "IEND") { ended = true; offset += 12; break; }
      offset += 12 + size;
    }
    if (!ended || !imageData || offset !== bytes.length) invalid();
    return [u32(bytes, 16), u32(bytes, 20)];
  }
  if (mime === "image/jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
        bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) invalid();
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) invalid();
      const marker = bytes[offset + 1];
      if (marker === 0xda) break;
      const size = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (size < 2 || offset + size + 2 > bytes.length) invalid();
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (size < 7) invalid();
        return [(bytes[offset + 7] << 8) | bytes[offset + 8],
                (bytes[offset + 5] << 8) | bytes[offset + 6]];
      }
      offset += size + 2;
    }
    invalid();
  }
  if (mime === "image/webp") {
    if (bytes.length < 30 || String.fromCharCode(...bytes.slice(0,4)) !== "RIFF" ||
        String.fromCharCode(...bytes.slice(8,12)) !== "WEBP") invalid();
    const riffSize = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
    if (riffSize + 8 !== bytes.length) invalid();
    const kind = String.fromCharCode(...bytes.slice(12,16));
    if (kind === "VP8X") {
      if ((bytes[20] & 0x02) !== 0) invalid(); // Animation flag.
      return [1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
              1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)];
    }
    if (kind === "VP8 ") {
      if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) invalid();
      return [(bytes[26] | (bytes[27] << 8)) & 0x3fff,
              (bytes[28] | (bytes[29] << 8)) & 0x3fff];
    }
    if (kind === "VP8L") {
      if (bytes[20] !== 0x2f) invalid();
      return [1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
              1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10)];
    }
    invalid();
  }
  invalid();
}

export function validateImages(images: unknown): string[] {
  if (!Array.isArray(images) || images.length < 1 || images.length > 8)
    throw new ApiError(422, "invalid_image", "Supply 1–8 image data URLs.");
  let totalBytes = 0;
  let totalPixels = 0;
  for (const image of images) {
    if (typeof image !== "string") invalid();
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match || match[2].length % 4 !== 0) invalid();
    const bytes = (match[2].length / 4) * 3 - (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0);
    totalBytes += bytes;
    if (totalBytes > MAX_DECODED) throw new ApiError(413, "image_size", "Images exceed 5 MiB decoded.");
    const decoded = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
    const [width, height] = dimensions(decoded, match[1]);
    if (width < 1 || height < 1) invalid();
    totalPixels += width * height;
    if (totalPixels > MAX_PIXELS) throw new ApiError(413, "image_pixels", "Images exceed 16 megapixels total.");
  }
  return images as string[];
}
