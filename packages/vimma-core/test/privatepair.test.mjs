import { describe, test, expect } from "vitest";
import { pairStep, parkedWindow } from "../src/privatepair.mjs";

// docs/specs/private-swap.md decisions 6 and 7; docs/specs/private-swap-macos.md decision 3:
// the pair's state machine knows nothing of a backend, so its window identifiers are opaque.

describe("the pair, with opaque identifiers (private-swap-macos decision 3)", () => {
  // The native backend's counter ids: not Hyprland addresses.
  const N = "1";
  const N2 = "2";
  const P = "3";
  const P2 = "window-4";
  /** @param {"normal" | "private"} parked */
  const pairOf = (parked, normal = N, priv = P) => ({ normal, private: priv, parked });

  test("entering hides the normal window and shows private in its place", () => {
    expect(pairStep(null, { type: "enter", normal: N, private: P })).toEqual({
      state: pairOf("normal"),
      ops: [{ show: P, place: N }],
    });
  });

  test("leaving shows the normal window in the private one's place, and back", () => {
    const left = pairStep(pairOf("normal"), { type: "leave" });
    expect(left).toEqual({ state: pairOf("private"), ops: [{ show: N, place: P }] });
    expect(pairStep(left.state, { type: "enter", normal: N, private: P })).toEqual({
      state: pairOf("normal"),
      ops: [{ show: P, place: N }],
    });
    expect(parkedWindow(pairOf("normal"))).toBe(N);
    expect(parkedWindow(pairOf("private"))).toBe(P);
    expect(parkedWindow(null)).toBeNull();
  });

  test("leaving with nothing hidden does nothing", () => {
    expect(pairStep(null, { type: "leave" })).toEqual({ state: null, ops: [] });
    expect(pairStep(pairOf("private"), { type: "leave" })).toEqual({
      state: pairOf("private"),
      ops: [],
    });
  });

  test("entering again while shown changes nothing", () => {
    const shown = pairOf("normal");
    expect(pairStep(shown, { type: "enter", normal: N, private: P })).toEqual({
      state: shown,
      ops: [],
    });
  });

  test("entering from a second normal window shows the hidden one again first", () => {
    expect(pairStep(pairOf("normal"), { type: "enter", normal: N2, private: P })).toEqual({
      state: pairOf("normal", N2),
      ops: [
        { show: N, place: P },
        { show: P, place: N2 },
      ],
    });
    expect(pairStep(pairOf("private"), { type: "enter", normal: N2, private: P })).toEqual({
      state: pairOf("normal", N2),
      ops: [{ show: P, place: N2 }],
    });
  });

  test("a new private window while one is hidden: the new one takes the slot", () => {
    expect(pairStep(pairOf("private"), { type: "enter", normal: N, private: P2 })).toEqual({
      state: pairOf("normal", N, P2),
      ops: [{ show: P2, place: N }],
    });
    expect(pairStep(pairOf("normal"), { type: "enter", normal: N, private: P2 }).ops).toEqual([
      { show: N, place: P },
      { show: P2, place: N },
    ]);
  });

  test("the slot window closing shows the hidden one in its place; never stranded", () => {
    expect(pairStep(pairOf("normal"), { type: "closing", window: P })).toEqual({
      state: null,
      ops: [{ show: N, place: P }],
    });
    expect(pairStep(pairOf("private"), { type: "closing", window: N })).toEqual({
      state: null,
      ops: [{ show: P, place: N }],
    });
  });

  test("the hidden window closing just forgets the pair", () => {
    const left = pairOf("private");
    expect(pairStep(left, { type: "closing", window: P })).toEqual({ state: null, ops: [] });
    expect(pairStep(left, { type: "closing", window: "9" })).toEqual({ state: left, ops: [] });
    expect(pairStep(null, { type: "closing", window: P })).toEqual({ state: null, ops: [] });
  });

  test("the hidden window activated (a link, the Window menu) comes back in place", () => {
    const shown = pairOf("normal");
    expect(pairStep(shown, { type: "activated", window: N })).toEqual({
      state: pairOf("private"),
      ops: [{ show: N, place: P }],
    });
    expect(pairStep(shown, { type: "activated", window: P })).toEqual({ state: shown, ops: [] });
    expect(pairStep(null, { type: "activated", window: N })).toEqual({ state: null, ops: [] });
  });

  test("the hidden window shown by someone else forgets the pair; no fight", () => {
    const shown = pairOf("normal");
    expect(pairStep(shown, { type: "unparked", window: N })).toEqual({ state: null, ops: [] });
    expect(pairStep(shown, { type: "unparked", window: P })).toEqual({ state: shown, ops: [] });
    expect(pairStep(null, { type: "unparked", window: N })).toEqual({ state: null, ops: [] });
  });

  test("a failure forgets the pair", () => {
    expect(pairStep(pairOf("normal"), { type: "failed" })).toEqual({ state: null, ops: [] });
  });
});
