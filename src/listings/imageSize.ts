/**
 * Reads the pixel size of a JPEG, PNG, WebP or GIF from its header, without decoding it.
 * OLX's post-ad body carries each photo's width and height.
 */
export interface ImageSize {
  width: number;
  height: number;
  /** The format detected from the file's bytes, e.g. `image/png`. */
  type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

export function imageSize(b: Uint8Array): ImageSize | undefined {
  // PNG: signature, then the IHDR chunk with width/height.
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR') {
    return ok(u32be(b, 16), u32be(b, 20), 'image/png');
  }
  // GIF: "GIF87a"/"GIF89a", then logical screen width/height.
  if (b.length >= 10 && ascii(b, 0, 3) === 'GIF') return ok(u16le(b, 6), u16le(b, 8), 'image/gif');
  // WebP: RIFF container with a VP8 / VP8L / VP8X chunk.
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return ok(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff, 'image/webp');
    }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, 'image/webp');
    }
    if (chunk === 'VP8X') return ok(u24le(b, 24) + 1, u24le(b, 27) + 1, 'image/webp');
    return undefined;
  }
  // JPEG: walk the segments until a start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) return undefined;
      const marker = b[o + 1]!;
      if (marker === 0xff) {
        o++; // fill byte
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2; // markers without a length
        continue;
      }
      const len = u16be(b, o + 2);
      // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return ok(u16be(b, o + 7), u16be(b, o + 5), 'image/jpeg');
      }
      if (len < 2) return undefined;
      o += 2 + len;
    }
  }
  return undefined;
}

function ok(width: number, height: number, type: ImageSize['type']): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height, type } : undefined;
}
