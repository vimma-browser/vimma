import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { decodePng, encodePng } from "../png.mjs";
import fc from "fast-check";
import { decodeXwd } from "../xwd.mjs";
import {
  CHANNEL_TOLERANCE,
  MAX_DIFF_RATIO,
  checkBaseline,
  diffImages,
  shotFailure,
} from "../screenshot.mjs";
import { defined } from "../../test/defined.ts";

const fixture = (/** @type {string} */ name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

/** @param {number} width @param {number} height @param {(x: number, y: number) => number[]} f */
function image(width, height, f) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(f(x, y), (y * width + x) * 4);
  }
  return { width, height, data };
}

/** @type {string[]} */
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "vimma-e2e-img-"));
  dirs.push(d);
  return d;
};

describe("PNG", () => {
  it("decodes ImageMagick's RGBA and RGB PNGs (Sub and Paeth filters) to RGBA", () => {
    for (const [png, raw] of [
      ["rgba.png", "rgba.raw"],
      ["rgb.png", "rgb.raw"],
    ]) {
      const img = decodePng(fixture(/** @type {string} */ (png)));
      expect([img.width, img.height]).toEqual([17, 13]);
      expect(Buffer.from(img.data).equals(fixture(/** @type {string} */ (raw)))).toBe(true);
    }
  });

  it("decodes every filter type, grey and grey+alpha", () => {
    // A hand-made 3×5 grey+alpha PNG, one row per filter type 0..4, filtered by the spec's rules.
    const w = 3;
    const bpp = 2;
    const rows = [0, 1, 2, 3, 4].map((r) =>
      Uint8Array.from({ length: w * bpp }, (_, i) => (r * 37 + i * 53) & 0xff),
    );
    const paeth = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ c) => {
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    const raw = [];
    for (let y = 0; y < rows.length; y++) {
      const row = /** @type {Uint8Array} */ (rows[y]);
      const prev = rows[y - 1] ?? new Uint8Array(w * bpp);
      raw.push(y);
      for (let i = 0; i < row.length; i++) {
        const a = i >= bpp ? /** @type {number} */ (row[i - bpp]) : 0;
        const b = /** @type {number} */ (prev[i]);
        const c = i >= bpp ? /** @type {number} */ (prev[i - bpp]) : 0;
        const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][y] ?? 0;
        raw.push((defined(row[i]) - pred) & 0xff);
      }
    }
    const png = rawPng(w, rows.length, 4, Uint8Array.from(raw));
    const img = decodePng(png);
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < w; x++) {
        const g = rows[y]?.[x * 2];
        const a = rows[y]?.[x * 2 + 1];
        expect([...img.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)]).toEqual([g, g, g, a]);
      }
    }
  });

  it("round-trips through encodePng", () => {
    const img = image(31, 7, (x, y) => [x * 8, y * 30, (x * y) & 0xff, x % 2 ? 255 : 128]);
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(31);
    expect(Buffer.from(back.data).equals(Buffer.from(img.data))).toBe(true);
  });

  it("rejects what it does not support, and corrupt files", () => {
    expect(() => decodePng(Buffer.from("GIF89a"))).toThrow(/not a PNG/);
    const good = encodePng(image(2, 2, () => [1, 2, 3, 4]));
    const bad = Buffer.from(good);
    bad.writeUInt8(bad.readUInt8(bad.length - 20) ^ 0xff, bad.length - 20); // inside IDAT: CRC no longer matches
    expect(() => decodePng(bad)).toThrow(/CRC/);
    expect(() => decodePng(rawPng(1, 1, 3, Uint8Array.from([0, 0])))).toThrow(/colour type 3/);
    expect(() => decodePng(rawPng(1, 1, 6, Uint8Array.from([0, 0]), 16))).toThrow(/bit depth 16/);
  });
});

describe("XWD (Xvfb -fbdir)", () => {
  it("decodes ImageMagick's 24-bit MSB-first XWD", () => {
    const img = decodeXwd(fixture("rgb.xwd"));
    expect([img.width, img.height]).toEqual([17, 13]);
    expect(Buffer.from(img.data).equals(fixture("rgb.raw"))).toBe(true);
  });

  it("decodes Xvfb's layout: 32 bpp, LSB-first pixels, colormap entries, either header order", () => {
    const pixels = [
      [0x11, 0x22, 0x33],
      [0xff, 0x00, 0x80],
      [0x00, 0xfe, 0x01],
    ];
    for (const littleHeader of [false, true]) {
      const img = decodeXwd(xvfbXwd(3, 1, pixels, littleHeader));
      expect([...img.data]).toEqual(pixels.flatMap((p) => [...p, 255]));
    }
  });

  it("rejects a truncated file and a non-XWD", () => {
    const full = xvfbXwd(
      3,
      1,
      [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      false,
    );
    expect(() => decodeXwd(full.subarray(0, full.length - 1))).toThrow(/truncated/);
    expect(() => decodeXwd(Buffer.alloc(200))).toThrow(/not an XWD/);
  });

  // A hostile or corrupt header must fail fast, never hang or misread.
  const black = () => xvfbXwd(3, 2, [[0, 0, 0]], false);
  /** @param {number} field @param {number} value */
  const patched = (field, value) => {
    const buf = Buffer.from(black());
    buf.writeUInt32BE(value >>> 0, field * 4);
    return buf;
  };
  it.each([
    ["red_mask 0xFFFFFFFF", 14, 0xffffffff, /colour mask/],
    ["a non-contiguous mask", 15, 0x0f0f00, /colour mask/],
    ["overlapping masks", 16, 0xff00, /colour mask/],
    ["bytes_per_line below width × bpp", 12, 11, /bytes_per_line/],
    ["header_size 0", 0, 0, /header_size/],
    ["header_size below the fixed header", 0, 99, /header_size/],
    ["width 0", 4, 0, /dimensions/],
    ["an implausible height", 5, 1_000_000, /dimensions/],
    ["a huge colormap", 19, 0x7fffffff, /truncated|ncolors/],
  ])("rejects %s", (_what, field, value, message) => {
    expect(() => decodeXwd(patched(field, value))).toThrow(message);
  });

  it("never hangs or throws a non-Error on any corrupted header field (fuzz)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 24 }),
        fc.oneof(fc.constantFrom(0, 1, 7, 31, 32, 0xffffffff, 0x80000000), fc.nat()),
        (field, value) => {
          try {
            const img = decodeXwd(patched(field, value));
            expect(img.data.length).toBe(img.width * img.height * 4);
          } catch (e) {
            expect(e).toBeInstanceOf(Error);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("diffImages (plan §4: 0.5 % tolerance)", () => {
  const W = 100;
  const H = 100; // 10 000 pixels: 0.5 % is exactly 50
  const base = image(W, H, () => [200, 200, 200, 255]);
  /** @param {number} n */
  const withDiffs = (n) =>
    image(W, H, (x, y) => (y * W + x < n ? [0, 0, 0, 255] : [200, 200, 200, 255]));

  it("uses 0.5 % and a per-channel tolerance of 2", () => {
    expect(MAX_DIFF_RATIO).toBe(0.005);
    expect(CHANNEL_TOLERANCE).toBe(2);
  });

  it("passes at exactly 0.5 % of pixels and fails one pixel over", () => {
    expect(diffImages(base, withDiffs(50))).toMatchObject({
      diffPixels: 50,
      ratio: 0.005,
      pass: true,
    });
    expect(diffImages(base, withDiffs(51))).toMatchObject({ diffPixels: 51, pass: false });
  });

  it("does not count channel differences within the tolerance", () => {
    const near = image(W, H, () => [202, 198, 200, 253]);
    const far = image(W, H, () => [203, 200, 200, 255]);
    expect(diffImages(base, near)).toMatchObject({ diffPixels: 0, pass: true });
    expect(diffImages(base, far)).toMatchObject({ diffPixels: W * H, ratio: 1, pass: false });
  });

  it("fails on a size mismatch without comparing pixels", () => {
    expect(
      diffImages(
        base,
        image(W, H + 1, () => [200, 200, 200, 255]),
      ),
    ).toMatchObject({
      pass: false,
      sizeMismatch: true,
    });
  });

  it("marks differing pixels red in the diff image", () => {
    const { diffImage } = diffImages(base, withDiffs(1));
    expect([...diffImage.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(diffImage.data[4]).not.toBe(255);
  });
});

describe("checkBaseline", () => {
  const img = image(10, 10, () => [10, 20, 30, 255]);

  it("fails when the baseline is missing and says how to create it", () => {
    const dir = tempDir();
    const out = tempDir();
    const r = checkBaseline({ name: "m0-x", image: img, baselineDir: dir, outDir: out });
    expect(r.status).toBe("missing");
    expect(r.message).toMatch(/--update-baselines[^]*commit body/);
    expect(existsSync(join(dir, "m0-x.png"))).toBe(false);
    // the actual image lands in e2e-output/, so CI's run can supply the first baseline
    expect(decodePng(readFileSync(join(out, "m0-x.actual.png")))).toEqual(img);
    expect(r.message).toContain(join(out, "m0-x.actual.png"));
  });

  it("writes the baseline only with update, then matches it", () => {
    const dir = tempDir();
    expect(
      checkBaseline({ name: "m0-x", image: img, baselineDir: dir, outDir: dir, update: true })
        .status,
    ).toBe("updated");
    expect(checkBaseline({ name: "m0-x", image: img, baselineDir: dir, outDir: dir }).status).toBe(
      "match",
    );
  });

  it("writes the actual and diff images on a mismatch", () => {
    const base = tempDir();
    const out = tempDir();
    writeFileSync(join(base, "m0-x.png"), encodePng(image(10, 10, () => [0, 0, 0, 255])));
    const r = checkBaseline({ name: "m0-x", image: img, baselineDir: base, outDir: out });
    expect(r.status).toBe("mismatch");
    expect(r.message).toMatch(/100\.00 % of pixels differ \(max 0\.5 %\)/);
    expect(decodePng(readFileSync(join(out, "m0-x.actual.png"))).width).toBe(10);
    expect(existsSync(join(out, "m0-x.diff.png"))).toBe(true);
  });
});

/**
 * A PNG with the given already-filtered scanlines.
 * @param {number} w @param {number} h @param {number} colourType @param {Uint8Array} raw
 * @param {number} [depth]
 */
function rawPng(w, h, colourType, raw, depth = 8) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth;
  ihdr[9] = colourType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * An XWD as Xvfb writes it for `-screen 0 WxHx24`: TrueColor, 32 bits per pixel, pixels
 * LSB-first, a window name and 256 colormap entries before the pixels.
 * @param {number} w @param {number} h @param {number[][]} pixels @param {boolean} littleHeader
 */
function xvfbXwd(w, h, pixels, littleHeader) {
  const name = Buffer.from("Xvfb main window\0");
  const headerSize = 100 + name.length;
  const ncolors = 256;
  const bpl = w * 4;
  const header = Buffer.alloc(100);
  const fields = [
    headerSize,
    7,
    2,
    24,
    w,
    h,
    0,
    /* byte_order LSBFirst */ 0,
    32,
    0,
    32,
    32,
    bpl,
    4,
    0xff0000,
    0xff00,
    0xff,
    8,
    ncolors,
    ncolors,
    w,
    h,
    0,
    0,
    0,
  ];
  fields.forEach((v, i) =>
    littleHeader ? header.writeUInt32LE(v, i * 4) : header.writeUInt32BE(v, i * 4),
  );
  const colors = Buffer.alloc(ncolors * 12);
  const body = Buffer.alloc(bpl * h);
  pixels.forEach(([r, g, b], i) =>
    body.writeUInt32LE(((r ?? 0) << 16) | ((g ?? 0) << 8) | (b ?? 0), i * 4),
  );
  return Buffer.concat([header, name, colors, body]);
}

// Issue #953: what e2e.mjs's screenshot step hands runSteps, which fails the scenario at its end.
describe("shotFailure", () => {
  it("gives the message of a missing or differing baseline, nothing for a match or a rewrite", () => {
    expect(shotFailure({ status: "mismatch", message: "2.5 % differ" })).toBe("2.5 % differ");
    expect(shotFailure({ status: "missing", message: "no baseline" })).toBe("no baseline");
    expect(shotFailure({ status: "match", message: "0.00 %" })).toBeUndefined();
    expect(shotFailure({ status: "updated", message: "wrote it" })).toBeUndefined();
  });
});
