import { describe, expect, it } from "vitest";
import {
  childEnv,
  expectSafeBrowsingKey,
  machPythonBounds,
  mochitestCommand,
  pickMachPython,
} from "../mochitest.mjs";

const ENGINE = "/repo/engine/";
const TESTS = "browser/base/zen-components/tests/browser/";

describe("mochitestCommand", () => {
  it("runs the whole suite headless by default, against the full build", () => {
    const { args, env } = mochitestCommand([], ENGINE);
    expect(args).toEqual(["mochitest", "--headless", TESTS]);
    expect(env).toEqual({});
  });

  it("maps repo paths under the engine's symlinked tests/", () => {
    const { args } = mochitestCommand(["./tests/browser/browser_vimma_key_capture.js"], ENGINE);
    expect(args.at(-1)).toBe(`${TESTS}browser_vimma_key_capture.js`);
  });

  it("drops --headless with --headed and passes other flags through", () => {
    const { args } = mochitestCommand(["--headed", "--verbose", "tests/browser/"], ENGINE);
    expect(args).toEqual(["mochitest", "--verbose", TESTS]);
  });

  it("with --artifact uses the artifact mozconfig and our application.ini (ADR-010)", () => {
    const { args, env } = mochitestCommand(["--artifact", "tests/browser/"], ENGINE);
    expect(env).toEqual({ MOZCONFIG: "/repo/engine/mozconfig.artifact" });
    expect(args).toEqual([
      "mochitest",
      "--headless",
      "--setenv=XUL_APP_FILE=/repo/engine/obj-artifact/dist/bin/browser/application.ini",
      TESTS,
    ]);
  });

  it("passes the Safe Browsing key expectation to the browser (spec m0-safebrowsing-key)", () => {
    expect(mochitestCommand([], ENGINE, true).args).toEqual([
      "mochitest",
      "--headless",
      "--setenv=VIMMA_EXPECT_SAFEBROWSING_KEY=1",
      TESTS,
    ]);
    expect(mochitestCommand(["--artifact"], ENGINE, false).args).toContain(
      "--setenv=VIMMA_EXPECT_SAFEBROWSING_KEY=0",
    );
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

// Mach declares the Python range it supports; outside it the manifest parser breaks (Python 3.15
// rejects the capturing groups in manifestparser's re.Scanner), so the wrapper picks one inside it.
describe("machPythonBounds", () => {
  it("reads the supported range from engine/mach", () => {
    const mach = "MIN_PYTHON_VERSION = (3, 10)\nMAX_PYTHON_VERSION_TO_CONSIDER = (3, 14)\n";
    expect(machPythonBounds(mach)).toEqual({ min: [3, 10], max: [3, 14] });
  });

  it("returns null when mach no longer declares it", () => {
    expect(machPythonBounds("print('hi')")).toBeNull();
  });
});

describe("pickMachPython", () => {
  const BOUNDS = { min: [3, 10], max: [3, 14] };
  const PATH = "/mise/bin:/mise/shims:/usr/bin";
  const FILES = [
    "/mise/bin/python3",
    "/mise/shims/python3.14",
    "/usr/bin/python3",
    "/usr/bin/python3.14",
  ];
  /** @type {Record<string, string | null>} */
  const VERSIONS = {
    "/mise/bin/python3": "3.15.0",
    "/mise/shims/python3.14": null,
    "/usr/bin/python3": "3.14.8",
    "/usr/bin/python3.14": "3.14.8",
  };
  const exists = (/** @type {string} */ p) => FILES.includes(p);
  const probe = (/** @type {string} */ p) => VERSIONS[p] ?? null;

  it("skips a python3 first on PATH that is newer than mach supports", () => {
    const res = pickMachPython({ PATH }, BOUNDS, exists, probe);
    expect(res).toEqual({
      python: "/usr/bin/python3",
      version: "3.14.8",
      tried: ["/mise/bin/python3 (3.15.0)"],
    });
  });

  it("takes the first python3 on PATH when it is in range", () => {
    const res = pickMachPython({ PATH: "/usr/bin" }, BOUNDS, exists, probe);
    expect(res.python).toBe("/usr/bin/python3");
    expect(res.tried).toEqual([]);
  });

  it("falls back to a versioned python3.N inside the range", () => {
    const files = ["/a/python3", "/b/python3.12"];
    const res = pickMachPython(
      { PATH: "/a:/b" },
      BOUNDS,
      (p) => files.includes(p),
      (p) => (p === "/a/python3" ? "3.15.0" : "3.12.4"),
    );
    expect(res.python).toBe("/b/python3.12");
  });

  it("rejects one older than the range", () => {
    const res = pickMachPython(
      { PATH: "/a" },
      BOUNDS,
      (p) => p === "/a/python3",
      () => "3.9.18",
    );
    expect(res).toEqual({ python: null, version: null, tried: ["/a/python3 (3.9.18)"] });
  });

  it("uses VIMMA_MACH_PYTHON as given, without searching", () => {
    const res = pickMachPython(
      { PATH, VIMMA_MACH_PYTHON: "/opt/py/bin/python3" },
      BOUNDS,
      exists,
      probe,
    );
    expect(res).toEqual({ python: "/opt/py/bin/python3", version: null, tried: [] });
  });

  it("finds nothing when no candidate is in range", () => {
    const res = pickMachPython({ PATH: "/mise/bin" }, BOUNDS, exists, probe);
    expect(res.python).toBeNull();
    expect(res.tried).toEqual(["/mise/bin/python3 (3.15.0)"]);
  });
});
