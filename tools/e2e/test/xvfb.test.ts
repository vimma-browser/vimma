// The real display and capture path: start Xvfb as the harness does and read its framebuffer.
// Skipped where Xvfb is not installed, except in CI (e2e.yml sets E2E_REQUIRE_XVFB).
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { findXvfb, startXvfb } from "../launcher.mjs";
import { capture } from "../screenshot.mjs";

const xvfb = findXvfb();
if (!xvfb && process.env.E2E_REQUIRE_XVFB) {
  throw new Error("E2E_REQUIRE_XVFB is set but Xvfb is not installed (package xvfb)");
}

describe.skipIf(!xvfb)(`Xvfb${xvfb ? "" : " (skipped: Xvfb not installed)"}`, () => {
  it("starts on a free display, captures a black 1280×800 screen, and stops", async () => {
    const display = await startXvfb({ width: 1280, height: 800 });
    try {
      expect(display.display).toMatch(/^:\d+$/);
      const img = await capture(display.fbFile);
      expect([img.width, img.height]).toEqual([1280, 800]);
      const black = img.data.every((v, i) => (i % 4 === 3 ? v === 255 : v === 0));
      expect(black).toBe(true);
    } finally {
      await display.stop();
    }
    expect(existsSync(display.fbFile)).toBe(false);
  });
});

describe("startXvfb without Xvfb", () => {
  it("names the package when Xvfb is missing", async () => {
    await expect(startXvfb({ width: 10, height: 10, bin: "/nonexistent/Xvfb" })).rejects.toThrow(
      /xvfb[^]*xorg-server-xvfb/,
    );
  });
});
