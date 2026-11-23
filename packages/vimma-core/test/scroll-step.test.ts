// `[scroll] step` (docs/specs/m1-actor-insert-scroll.md, "Follow-up: scroll step", issue #1074):
// how far j, k, h and l scroll, checked in config.toml and again by the content actor.
import { describe, test, expect } from "vitest";
import { parseConfig } from "../src/config/config.mjs";
import { DEFAULT_CONFIG, formatDefaultsToml } from "../src/config/defaults.mjs";
import {
  SCROLL_STEP_DEFAULT,
  SCROLL_STEP_MAX,
  SCROLL_STEP_MIN,
  scrollStep,
} from "../src/page/scroll.mjs";

import type { ResolvedConfig } from "../src/config/config.mjs";

// A config.toml whose first line is a comment, so errors are on the lines they always were.
const cfg = (...lines: string[]) => ["# config.toml", ...lines].join("\n") + "\n";

function ok(text: string) {
  const r = parseConfig(text);
  expect(r.errors).toEqual([]);
  return r.config as ResolvedConfig;
}

function errors(text: string) {
  const r = parseConfig(text);
  expect(r.config).toBeNull();
  return r.errors.map((e) => ({
    line: e.line,
    path: e.path,
    message: e.message,
    ...(e.suggestion ? { suggestion: e.suggestion } : {}),
  }));
}

const RANGE = "must be an integer between 1 and 2000 (CSS pixels)";

describe("[scroll] step", () => {
  test("defaults to 60 CSS pixels, Vimium's scrollStepSize, in 1 to 2000", () => {
    expect([SCROLL_STEP_DEFAULT, SCROLL_STEP_MIN, SCROLL_STEP_MAX]).toEqual([60, 1, 2000]);
    expect(ok(cfg()).scroll).toEqual({ step: 60 });
    expect(DEFAULT_CONFIG.scroll).toEqual({ step: 60 });
    expect(formatDefaultsToml()).toMatch(/^\[scroll\]\n(#.*\n)*step = 60(?: +#.*)?$/m);
  });

  test.each([[1], [120], [2000]])("step = %i is accepted", (n) => {
    expect(ok(cfg("[scroll]", `step = ${n}`)).scroll.step).toBe(n);
  });

  test.each([["0"], ["2001"], ["-60"]])("step = %s is out of range", (v) => {
    expect(errors(cfg("[scroll]", `step = ${v}`))).toEqual([
      { line: 3, path: "scroll.step", message: RANGE },
    ]);
  });

  test.each([
    ["60.5", "expected an integer, got a float"],
    ['"60"', "expected an integer, got a string"],
    ["true", "expected an integer, got a boolean"],
  ])("step = %s is not an integer", (v, message) => {
    expect(errors(cfg("[scroll]", `step = ${v}`))).toEqual([
      { line: 3, path: "scroll.step", message },
    ]);
  });

  test("an unknown key is an error, with the nearest name", () => {
    expect(errors(cfg("[scroll]", "steps = 80"))).toEqual([
      { line: 3, path: "scroll.steps", message: 'unknown key "steps"', suggestion: "step" },
    ]);
  });

  test("is valid in a schema-1 file too", () => {
    expect(parseConfig("schema = 1\n[scroll]\nstep = 80\n").errors).toEqual([]);
  });
});

// The content actor's own check of the step the parent sends: it takes only what config.toml
// could have set, and anything else scrolls by the default.
describe("scrollStep", () => {
  test.each([[1], [60], [137], [2000]])("%s is kept", (n) => {
    expect(scrollStep(n)).toBe(n);
  });

  test.each([
    [0],
    [-60],
    [2001],
    [1e9],
    [60.5],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    ["60"],
    [60n],
    [null],
    [undefined],
    [{ valueOf: (): number => 60 }],
  ])("%s falls back to the default", (v) => {
    expect(scrollStep(v)).toBe(SCROLL_STEP_DEFAULT);
  });
});
