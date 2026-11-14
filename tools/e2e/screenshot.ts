// Screenshots for e2e scenarios (spec m0-e2e-harness): capture from the harness's Xvfb, compare
// with tests/e2e/baselines/<name>.png at plan §4's 0.5 % tolerance, write the actual and a diff
// image on a mismatch. Baselines change only with --update-baselines and a commit body saying why.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { decodePng, encodePng } from "./png.ts";
import { decodeXwd } from "./xwd.ts";
import type { Image } from "./png.ts";

/** Plan §4: screenshot diffs with 0.5 % tolerance (share of pixels that may differ). */
export const MAX_DIFF_RATIO = 0.005;
/** A pixel differs when any RGBA channel differs by more than this (absorbs rounding). */
export const CHANNEL_TOLERANCE = 2;

export function diffImages(
  expected: Image,
  actual: Image,
  {
    channelTolerance = CHANNEL_TOLERANCE,
    maxRatio = MAX_DIFF_RATIO,
  }: { channelTolerance?: number; maxRatio?: number } = {},
) {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      pass: false,
      sizeMismatch: true,
      diffPixels: NaN,
      total: actual.width * actual.height,
      ratio: 1,
      diffImage: actual,
    };
  }
  const total = actual.width * actual.height;
  const diff = new Uint8Array(total * 4);
  let diffPixels = 0;
  for (let p = 0; p < total * 4; p += 4) {
    let differs = false;
    for (let c = 0; c < 4; c++) {
      const e = expected.data[p + c] as number;
      const a = actual.data[p + c] as number;
      if (Math.abs(e - a) > channelTolerance) differs = true;
    }
    if (differs) {
      diffPixels++;
      diff.set([255, 0, 0, 255], p);
    } else {
      // a dimmed grey copy of the actual image, so the red stands out
      const a = actual.data;
      const grey = ((a[p] ?? 0) + (a[p + 1] ?? 0) + (a[p + 2] ?? 0)) / 3; // p + 2 < a.length: ?? never applies
      diff.set([grey / 3 + 128, grey / 3 + 128, grey / 3 + 128, 255].map(Math.round), p);
    }
  }
  const ratio = diffPixels / total;
  return {
    pass: ratio <= maxRatio,
    sizeMismatch: false,
    diffPixels,
    total,
    ratio,
    diffImage: { width: actual.width, height: actual.height, data: diff },
  };
}

export type BaselineResult = {
  status: "match" | "updated" | "missing" | "mismatch";
  message: string;
};

/**
 * What a screenshot step hands runSteps: the message of a missing or differing baseline, which
 * lets the steps go on and fails the scenario at its end (issue #953), or nothing.
 */
export function shotFailure(result: BaselineResult): string | undefined {
  return result.status === "missing" || result.status === "mismatch" ? result.message : undefined;
}

/** Compare `image` with `<baselineDir>/<name>.png`, or write it there with `update`. */
export function checkBaseline({
  name,
  image,
  baselineDir,
  outDir,
  update = false,
}: {
  name: string;
  image: Image;
  baselineDir: string;
  outDir: string;
  update?: boolean;
}): BaselineResult {
  const path = join(baselineDir, `${name}.png`);
  if (update) {
    mkdirSync(baselineDir, { recursive: true });
    writeFileSync(path, encodePng(image));
    return {
      status: "updated",
      message:
        `wrote ${path}: commit it with a commit body saying why it changed ` + "(CONTRIBUTING.md)",
    };
  }
  if (!existsSync(path)) {
    // The actual image goes to outDir, so a CI run's e2e-output artifact can supply a baseline
    // made in CI's environment (runbook, "Baselines").
    mkdirSync(outDir, { recursive: true });
    const actualPath = join(outDir, `${name}.actual.png`);
    writeFileSync(actualPath, encodePng(image));
    return {
      status: "missing",
      message:
        `no baseline ${path}; this run's image is ${actualPath}. Create it with ` +
        "--update-baselines (or take CI's), check it by eye, and commit it with a commit body " +
        "saying why (CONTRIBUTING.md: never change a baseline without one)",
    };
  }
  const result = diffImages(decodePng(readFileSync(path)), image);
  if (result.pass) {
    return { status: "match", message: `${(result.ratio * 100).toFixed(2)} % of pixels differ` };
  }
  mkdirSync(outDir, { recursive: true });
  const actualPath = join(outDir, `${name}.actual.png`);
  writeFileSync(actualPath, encodePng(image));
  let detail: string;
  if (result.sizeMismatch) {
    detail = `size differs from the baseline (got ${image.width}×${image.height})`;
  } else {
    writeFileSync(join(outDir, `${name}.diff.png`), encodePng(result.diffImage));
    detail =
      `${(result.ratio * 100).toFixed(2)} % of pixels differ (max ${MAX_DIFF_RATIO * 100} %); ` +
      `diff: ${join(outDir, `${name}.diff.png`)}`;
  }
  return { status: "mismatch", message: `${name}: ${detail}; actual: ${actualPath}` };
}

/**
 * Capture the screen of the harness's Xvfb from its `-fbdir` framebuffer file. Waits until two
 * frames `settleMs` apart are identical (at most `maxWaitMs`), so a half-painted frame is not
 * compared. The protocol's `screenshot` command (reserved in v1) replaces this once it exists.
 * @param fbFile `<fbdir>/Xvfb_screen0`
 */
export async function capture(
  fbFile: string,
  { settleMs = 200, maxWaitMs = 2000 }: { settleMs?: number; maxWaitMs?: number } = {},
): Promise<Image> {
  const deadline = Date.now() + maxWaitMs;
  let last = readFileSync(fbFile);
  for (;;) {
    await sleep(settleMs);
    const next = readFileSync(fbFile);
    if (next.equals(last) || Date.now() >= deadline) return decodeXwd(next);
    last = next;
  }
}
