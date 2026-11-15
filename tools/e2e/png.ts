// Minimal PNG for the e2e screenshots (spec m0-e2e-harness): decode 8-bit grey, grey+alpha, RGB
// and RGBA, non-interlaced, all five filter types; encode 8-bit RGBA. node:zlib only, so the
// harness needs no image dependency.
import { deflateSync, inflateSync } from "node:zlib";

/** RGBA, 4 bytes a pixel */
export type Image = { width: number; height: number; data: Uint8Array };

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bytes per pixel by colour type (8-bit samples). */
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(png: Uint8Array): Image {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let pos = 8;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  while (pos + 12 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    if (pos + 12 + length > buf.length) throw new Error(`PNG truncated in chunk ${type}`);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (crc32(buf.subarray(pos + 4, pos + 8 + length)) !== buf.readUInt32BE(pos + 8 + length)) {
      throw new Error(`PNG chunk ${type}: CRC mismatch`);
    }
    if (type === "IHDR") ihdr = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + length;
  }
  if (!ihdr) throw new Error("PNG without IHDR");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const [depth, colourType, , , interlace] = ihdr.subarray(8, 13);
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not supported (8 only)`);
  const channels = CHANNELS[colourType as number];
  if (!channels) throw new Error(`PNG colour type ${colourType} is not supported`);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is truncated");
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    const row = new Uint8Array(raw.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (row[i - channels] as number) : 0;
      const b = prev[i] as number;
      const c = i >= channels ? (prev[i - channels] as number) : 0;
      let pred;
      switch (filter) {
        case 0:
          pred = 0;
          break;
        case 1:
          pred = a;
          break;
        case 2:
          pred = b;
          break;
        case 3:
          pred = (a + b) >> 1;
          break;
        case 4:
          pred = paeth(a, b, c);
          break;
        default:
          throw new Error(`PNG row ${y}: unknown filter type ${filter}`);
      }
      row[i] = ((row[i] ?? 0) + pred) & 0xff; // i < row.length: ?? never applies
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (channels <= 2) {
        const g = row[s] as number;
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = channels === 2 ? (row[s + 1] as number) : 255;
      } else {
        out[o] = row[s] as number;
        out[o + 1] = row[s + 1] as number;
        out[o + 2] = row[s + 2] as number;
        out[o + 3] = channels === 4 ? (row[s + 3] as number) : 255;
      }
    }
    prev = row;
  }
  return { width, height, data: out };
}

function chunk(type: string, data: Buffer) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * 8-bit RGBA PNG. Each row takes whichever of the None, Sub and Up filters gives the smallest
 * sum of absolute values (the usual heuristic), which keeps UI screenshots small.
 */
export function encodePng({ width, height, data }: Image): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  const candidates = [0, 1, 2].map(() => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 3; f++) {
      const cand = candidates[f] as Uint8Array;
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const pred =
          f === 1 ? (i >= 4 ? (row[i - 4] as number) : 0) : f === 2 ? (prev[i] as number) : 0;
        const v = ((row[i] ?? 0) - pred) & 0xff;
        cand[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    raw[y * (stride + 1)] = best;
    raw.set(candidates[best] as Uint8Array, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
