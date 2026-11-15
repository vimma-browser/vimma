// Decode an XWD (X Window Dump) image: the format Xvfb keeps its framebuffer in when started
// with `-fbdir DIR` (DIR/Xvfb_screen0), and what `xwd` writes. Spec m0-e2e-harness: this is how
// the harness captures the screen until the control protocol's `screenshot` command exists.
// Only TrueColor/DirectColor ZPixmaps (Xvfb at depth 16/24/32) are supported.
import type { Image } from "./png.ts";

const XWD_FILE_VERSION = 7;
const HEADER_FIELDS = 25;
const Z_PIXMAP = 2;
const COLOR_ENTRY_SIZE = 12;

/** Largest width or height accepted; Xvfb screens are far smaller. */
const MAX_DIMENSION = 16384;

/**
 * Shift and maximum of a colour mask, to scale its channel to 8 bits. The mask must be one run
 * of 1 to 16 set bits inside `bpp` bits. The loops are bounded by 32 iterations, so a hostile
 * mask (0xFFFFFFFF: `>>> 32` is `>>> 0`) cannot spin forever.
 */
function maskInfo(mask: number, bpp: number) {
  let shift = 0;
  while (shift < 32 && ((mask >>> shift) & 1) === 0) shift++;
  let bits = 0;
  while (shift + bits < 32 && ((mask >>> (shift + bits)) & 1) === 1) bits++;
  const contiguous = shift + bits >= 32 || mask >>> (shift + bits) === 0;
  if (mask === 0 || bits > 16 || !contiguous || shift + bits > bpp) {
    throw new Error(`XWD: bad colour mask 0x${(mask >>> 0).toString(16)} for ${bpp} bpp`);
  }
  return { shift, max: 2 ** bits - 1 };
}

export function decodeXwd(file: Uint8Array): Image {
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (buf.length < HEADER_FIELDS * 4) throw new Error("not an XWD file (too short)");
  // The header is written MSB-first by xwd and Xvfb; accept either order, decided by the version.
  const big = buf.readUInt32BE(4) === XWD_FILE_VERSION;
  if (!big && buf.readUInt32LE(4) !== XWD_FILE_VERSION) {
    throw new Error("not an XWD file (file_version is not 7)");
  }
  const field = (i: number) => (big ? buf.readUInt32BE(i * 4) : buf.readUInt32LE(i * 4));
  const [headerSize, , format, , width, height, , byteOrder, , , , bpp, bytesPerLine] = Array.from(
    { length: 13 },
    (_, i) => field(i),
  );
  const masks: [number, number, number] = [field(14), field(15), field(16)];
  const ncolors = field(19);
  if ((headerSize as number) < HEADER_FIELDS * 4) {
    throw new Error(
      `XWD: header_size ${headerSize} is smaller than the ${HEADER_FIELDS * 4}-byte header`,
    );
  }
  if (format !== Z_PIXMAP) throw new Error(`XWD: pixmap format ${format} is not ZPixmap`);
  if (bpp !== 16 && bpp !== 24 && bpp !== 32) throw new Error(`XWD: ${bpp} bits per pixel`);
  if (byteOrder !== 0 && byteOrder !== 1) throw new Error(`XWD: byte_order ${byteOrder}`);
  for (const d of [width, height]) {
    if (!d || d > MAX_DIMENSION) {
      throw new Error(`XWD: implausible dimensions ${width}×${height} (max ${MAX_DIMENSION})`);
    }
  }
  if ((bytesPerLine as number) < (width as number) * ((bpp / 8) as number)) {
    throw new Error(`XWD: bytes_per_line ${bytesPerLine} is less than width × bytes per pixel`);
  }
  const w = width as number;
  const h = height as number;
  const bpl = bytesPerLine as number;
  const bytes = (bpp as number) / 8;
  const offset = (headerSize as number) + ncolors * COLOR_ENTRY_SIZE;
  if (offset + bpl * h > buf.length) {
    throw new Error(`XWD truncated: ${buf.length} bytes, need ${offset + bpl * h}`);
  }
  const [r, g, b] = masks.map((m) => maskInfo(m, bpp as number));
  if ((masks[0] & masks[1]) | (masks[0] & masks[2]) | (masks[1] & masks[2])) {
    throw new Error("XWD: overlapping colour masks");
  }
  const out = new Uint8Array(w * h * 4);
  if (bytes === 4 && byteOrder === 0 && masks.join() === "16711680,65280,255") {
    // Xvfb at depth 24 on a little-endian host: bytes are B, G, R, X. A fast path for 1 Mpx.
    for (let y = 0; y < h; y++) {
      for (let x = 0, p = offset + y * bpl, o = y * w * 4; x < w; x++, p += 4, o += 4) {
        out[o] = buf[p + 2] as number;
        out[o + 1] = buf[p + 1] as number;
        out[o + 2] = buf[p] as number;
        out[o + 3] = 255;
      }
    }
    return { width: w, height: h, data: out };
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = offset + y * bpl + x * bytes;
      let v = 0;
      for (let k = 0; k < bytes; k++) {
        // byte_order 0 = LSBFirst, 1 = MSBFirst
        const byte = buf[byteOrder === 0 ? p + bytes - 1 - k : p + k] as number;
        v = v * 256 + byte;
      }
      const o = (y * w + x) * 4;
      for (const [c, info] of [r, g, b].entries()) {
        const { shift, max } = info as { shift: number; max: number };
        out[o + c] = Math.round(((Math.floor(v / 2 ** shift) & max) * 255) / max);
      }
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}
