import { describe, test, expect } from "vitest";
import { frameApplied, openFrame, planNativeShow } from "../src/nativeswap.mjs";

// docs/specs/private-swap-macos.md decisions 2, 7 and 13: "show X in place of Y" on macOS,
// planned from two plain frame records.

/** @param {object} [over] */
function frame(over = {}) {
  return {
    x: 120,
    y: 80,
    width: 1280,
    height: 800,
    sizemode: /** @type {const} */ ("normal"),
    restored: null,
    ...over,
  };
}

const ZOOMED = { x: 0, y: 25, width: 1512, height: 920 };
const RESTORED = { x: 200, y: 140, width: 1100, height: 700 };

describe("planNativeShow: show X in Y's place (Design: the mechanism)", () => {
  test("a normal Y: X takes its frame as it is", () => {
    expect(planNativeShow(frame({ x: 5, y: 6, width: 700, height: 500 }), frame())).toEqual({
      kind: "swap",
      frame: { x: 120, y: 80, width: 1280, height: 800 },
      restoreFirst: false,
      zoom: false,
    });
  });

  test("a zoomed Y with a restored frame: X goes to that frame, then zooms", () => {
    const y = frame({ ...ZOOMED, sizemode: "maximized", restored: RESTORED });
    expect(planNativeShow(frame(), y)).toEqual({
      kind: "swap",
      frame: RESTORED,
      restoreFirst: false,
      zoom: true,
    });
  });

  test("a zoomed Y without a restored frame: X goes to the zoomed frame and zooms", () => {
    const y = frame({ ...ZOOMED, sizemode: "maximized", restored: null });
    expect(planNativeShow(frame(), y)).toEqual({
      kind: "swap",
      frame: ZOOMED,
      restoreFirst: false,
      zoom: true,
    });
  });

  test("a zoomed Y whose restored frame is unusable falls back to the zoomed frame", () => {
    const y = frame({ ...ZOOMED, sizemode: "maximized", restored: { ...RESTORED, width: 0 } });
    expect(planNativeShow(frame(), y)).toMatchObject({ kind: "swap", frame: ZOOMED, zoom: true });
  });

  test("X zoomed and Y not: X is restored first", () => {
    const x = frame({ ...ZOOMED, sizemode: "maximized", restored: RESTORED });
    expect(planNativeShow(x, frame())).toEqual({
      kind: "swap",
      frame: { x: 120, y: 80, width: 1280, height: 800 },
      restoreFirst: true,
      zoom: false,
    });
  });

  test("both zoomed: X is restored, given Y's restored frame and zoomed again", () => {
    const x = frame({ ...ZOOMED, sizemode: "maximized", restored: RESTORED });
    const y = frame({ ...ZOOMED, x: 1512, sizemode: "maximized", restored: null });
    expect(planNativeShow(x, y)).toEqual({
      kind: "swap",
      frame: { ...ZOOMED, x: 1512 },
      restoreFirst: true,
      zoom: true,
    });
  });

  test("frames on a second screen with negative coordinates are kept", () => {
    const y = frame({ x: -1920, y: -300, width: 960, height: 1050 });
    expect(planNativeShow(frame(), y)).toMatchObject({
      kind: "swap",
      frame: { x: -1920, y: -300, width: 960, height: 1050 },
    });
  });

  test("a Y in native full screen is never hidden (decision 7)", () => {
    expect(planNativeShow(frame(), frame({ sizemode: "fullscreen" }))).toEqual({
      kind: "fullscreen",
    });
  });

  test("a minimized window is refused, either side", () => {
    expect(planNativeShow(frame(), frame({ sizemode: "minimized" }))).toEqual({
      kind: "refuse",
      reason: "the window is minimized",
    });
    expect(planNativeShow(frame({ sizemode: "minimized" }), frame())).toEqual({
      kind: "refuse",
      reason: "the window is minimized",
    });
  });

  test("X in full screen is refused: it is not a window to put in a slot", () => {
    expect(planNativeShow(frame({ sizemode: "fullscreen" }), frame())).toEqual({
      kind: "refuse",
      reason: "the window is in full screen",
    });
  });

  test("a zero-size or broken frame is refused", () => {
    for (const bad of [
      frame({ width: 0 }),
      frame({ height: 0 }),
      frame({ width: -5 }),
      frame({ x: Number.NaN }),
      frame({ y: Infinity }),
      frame({ width: "800" }),
      frame({ x: 1e12 }),
      frame({ sizemode: "tiled" }),
    ]) {
      expect(planNativeShow(frame(), bad)).toEqual({ kind: "refuse", reason: "a bad frame" });
    }
    expect(planNativeShow(frame({ height: 0 }), frame())).toEqual({
      kind: "refuse",
      reason: "a bad frame",
    });
  });
});

describe("openFrame: where a new private window opens", () => {
  test("a normal window's frame, or a zoomed one's restored frame", () => {
    expect(openFrame(frame())).toEqual({ x: 120, y: 80, width: 1280, height: 800 });
    expect(openFrame(frame({ ...ZOOMED, sizemode: "maximized", restored: RESTORED }))).toEqual(
      RESTORED,
    );
    expect(openFrame(frame({ ...ZOOMED, sizemode: "maximized" }))).toEqual(ZOOMED);
  });

  test("none for a fullscreen, minimized or broken window", () => {
    expect(openFrame(frame({ sizemode: "fullscreen" }))).toBeNull();
    expect(openFrame(frame({ sizemode: "minimized" }))).toBeNull();
    expect(openFrame(frame({ width: 0 }))).toBeNull();
  });
});

describe("frameApplied: the shown window reports what it was given (decision 9)", () => {
  const plan = /** @type {const} */ ({
    kind: "swap",
    frame: { x: 120, y: 80, width: 1280, height: 800 },
    restoreFirst: false,
    zoom: false,
  });

  test("the same frame, to a pixel of rounding", () => {
    expect(frameApplied(plan, frame())).toBe(true);
    expect(frameApplied(plan, frame({ x: 121, height: 799 }))).toBe(true);
    expect(frameApplied(plan, frame({ x: 130 }))).toBe(false);
    expect(frameApplied(plan, frame({ width: 1000 }))).toBe(false);
    expect(frameApplied(plan, frame({ sizemode: "maximized" }))).toBe(false);
  });

  test("a zoom only has to end zoomed", () => {
    const zoom = { ...plan, zoom: true };
    expect(frameApplied(zoom, frame({ ...ZOOMED, sizemode: "maximized" }))).toBe(true);
    expect(frameApplied(zoom, frame())).toBe(false);
  });
});
