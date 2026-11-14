import { describe, expect, it } from "vitest";
import { childEnv, expectSafeBrowsingKey, mochitestCommand } from "../mochitest.mjs";

const ENGINE = "/repo/engine/";
const TESTS = "browser/base/zen-components/tests/browser/";
/** These expectations are Linux's; macOS adds a sandbox flag (below). */
const LINUX = { platform: "linux" };

describe("mochitestCommand", () => {
  it("runs the whole suite headless by default, against the full build", () => {
    const { args, env } = mochitestCommand([], ENGINE, undefined, LINUX);
    expect(args).toEqual(["mochitest", "--headless", TESTS]);
    expect(env).toEqual({});
  });

  it("maps repo paths under the engine's symlinked tests/", () => {
    const { args } = mochitestCommand(
      ["./tests/browser/browser_vimma_key_capture.js"],
      ENGINE,
      undefined,
      LINUX,
    );
    expect(args.at(-1)).toBe(`${TESTS}browser_vimma_key_capture.js`);
  });

  it("drops --headless with --headed and passes other flags through", () => {
    const { args } = mochitestCommand(
      ["--headed", "--verbose", "tests/browser/"],
      ENGINE,
      undefined,
      LINUX,
    );
    expect(args).toEqual(["mochitest", "--verbose", TESTS]);
  });

  it("with --artifact uses the artifact mozconfig and our application.ini (ADR-010)", () => {
    const { args, env } = mochitestCommand(
      ["--artifact", "tests/browser/"],
      ENGINE,
      undefined,
      LINUX,
    );
    expect(env).toEqual({ MOZCONFIG: "/repo/engine/mozconfig.artifact" });
    expect(args).toEqual([
      "mochitest",
      "--headless",
      "--setenv=XUL_APP_FILE=/repo/engine/obj-artifact/dist/bin/browser/application.ini",
      TESTS,
    ]);
  });

  it("passes the Safe Browsing key expectation to the browser (spec m0-safebrowsing-key)", () => {
    expect(mochitestCommand([], ENGINE, true, LINUX).args).toEqual([
      "mochitest",
      "--headless",
      "--setenv=VIMMA_EXPECT_SAFEBROWSING_KEY=1",
      TESTS,
    ]);
    expect(mochitestCommand(["--artifact"], ENGINE, false, LINUX).args).toContain(
      "--setenv=VIMMA_EXPECT_SAFEBROWSING_KEY=0",
    );
  });
});

describe("mochitestCommand on macOS", () => {
  const SRC = "/Users/u/vimma/src";

  it("lets the mac content sandbox read the repo's src/, which engine/ links to", () => {
    const { args } = mochitestCommand([], ENGINE, undefined, { platform: "darwin", src: SRC });
    expect(args).toEqual([
      "mochitest",
      "--headless",
      "--sandbox-read-whitelist=/Users/u/vimma/src",
      TESTS,
    ]);
    const artifact = mochitestCommand(["--artifact"], ENGINE, undefined, {
      platform: "darwin",
      src: SRC,
    });
    expect(artifact.args).toContain("--sandbox-read-whitelist=/Users/u/vimma/src");
  });

  it("adds nothing on Linux, whose runs already pass without it", () => {
    const { args } = mochitestCommand([], ENGINE, undefined, { platform: "linux", src: SRC });
    expect(args).toEqual(["mochitest", "--headless", TESTS]);
  });
});

describe("expectSafeBrowsingKey", () => {
  const HOME = "/home/u";
  const DEFAULT = "/home/u/.config/vimma/keys/safebrowsing";
  /** @param {string[]} files */
  const exists = (files) => (/** @type {string} */ p) => files.includes(p);

  it("expects a key when the default key file exists", () => {
    expect(expectSafeBrowsingKey({}, HOME, exists([DEFAULT]))).toBe(true);
    expect(expectSafeBrowsingKey({}, HOME, exists([]))).toBe(false);
  });

  it("uses VIMMA_SAFEBROWSING_KEYFILE instead of the default path, as the mozconfig does", () => {
    const env = { VIMMA_SAFEBROWSING_KEYFILE: "/tmp/k" };
    expect(expectSafeBrowsingKey(env, HOME, exists(["/tmp/k"]))).toBe(true);
    expect(expectSafeBrowsingKey(env, HOME, exists([DEFAULT]))).toBe(false);
  });

  it("lets VIMMA_EXPECT_SAFEBROWSING_KEY override (the nightly deletes its key file before tests)", () => {
    expect(expectSafeBrowsingKey({ VIMMA_EXPECT_SAFEBROWSING_KEY: "1" }, HOME, exists([]))).toBe(
      true,
    );
    expect(
      expectSafeBrowsingKey({ VIMMA_EXPECT_SAFEBROWSING_KEY: "0" }, HOME, exists([DEFAULT])),
    ).toBe(false);
  });
});

// docs/specs/private-swap.md: a test browser must never reach the developer's own Hyprland,
// even with --headed; browser_vimma_private_swap.js brings its own fake.
describe("childEnv", () => {
  it("drops HYPRLAND_INSTANCE_SIGNATURE and keeps the rest", () => {
    const env = childEnv(
      { HOME: "/home/u", HYPRLAND_INSTANCE_SIGNATURE: "abc_1", XDG_RUNTIME_DIR: "/run/user/1" },
      { MOZCONFIG: "/m" },
    );
    expect(env).toEqual({ HOME: "/home/u", XDG_RUNTIME_DIR: "/run/user/1", MOZCONFIG: "/m" });
  });
});
