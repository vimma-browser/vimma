// The Python interpreter tools/mochitest.mjs and tools/build.mjs run mach with (#436, #458).
import { describe, expect, it } from "vitest";
import { existsSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import {
  machEnv,
  machPythonBounds,
  pickMachPython,
  pickReport,
  writePythonShim,
} from "../mach-python.mjs";
import { tempDir } from "./temp-dir.mjs";

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

describe("pickReport", () => {
  const BOUNDS = { min: [3, 10], max: [3, 14] };

  it("names the range, what it found and VIMMA_MACH_PYTHON when nothing fits", () => {
    const res = pickReport("npm run build", BOUNDS, {
      python: null,
      version: null,
      tried: ["/mise/bin/python3 (3.15.0)"],
    });
    expect(res.note).toBeNull();
    expect(res.error).toEqual([
      "npm run build: mach supports Python 3.10 to 3.14 (engine/mach), and none was found on PATH.",
      "Found outside that range: /mise/bin/python3 (3.15.0).",
      "Install a Python in that range, or set VIMMA_MACH_PYTHON to one.",
    ]);
  });

  it("says which interpreter it chose when it skipped another", () => {
    const res = pickReport("npm run build", BOUNDS, {
      python: "/usr/bin/python3",
      version: "3.14.8",
      tried: ["/mise/bin/python3 (3.15.0)"],
    });
    expect(res).toEqual({
      error: null,
      note: "npm run build: using /usr/bin/python3 (3.14.8); mach supports Python 3.10 to 3.14.",
    });
  });

  it("stays quiet when the first python3 fits", () => {
    const res = pickReport("npm run build", BOUNDS, {
      python: "/usr/bin/python3",
      version: "3.14.8",
      tried: [],
    });
    expect(res).toEqual({ error: null, note: null });
  });
});

// Surfer runs `./mach`, whose `#!/usr/bin/env python3` takes the first python3 on PATH, so the
// build puts a directory whose python3 is the chosen interpreter first on PATH.
describe("writePythonShim", () => {
  it("links python3 and python to the chosen interpreter", () => {
    const dir = tempDir("vimma-shim-");
    writePythonShim(dir, "/usr/bin/python3");
    expect(readlinkSync(join(dir, "python3"))).toBe("/usr/bin/python3");
    expect(readlinkSync(join(dir, "python"))).toBe("/usr/bin/python3");
    expect(existsSync(join(dir, "python3.15"))).toBe(false);
  });
});

describe("machEnv", () => {
  const HOME = "/home/u";
  const SCCACHE_DIR = "/home/u/.mozbuild/sccache";

  it("puts the shim first on PATH", () => {
    const env = machEnv({ PATH: "/mise/bin:/usr/bin", HOME }, "/tmp/shim", HOME, () => false);
    expect(env.PATH).toBe("/tmp/shim:/mise/bin:/usr/bin");
    expect(env.HOME).toBe(HOME);
  });

  it("adds the bootstrapped sccache directory last when it has sccache", () => {
    const env = machEnv(
      { PATH: "/usr/bin" },
      "/tmp/shim",
      HOME,
      (p) => p === `${SCCACHE_DIR}/sccache`,
    );
    expect(env.PATH).toBe(`/tmp/shim:/usr/bin:${SCCACHE_DIR}`);
  });

  it("does not add the sccache directory twice", () => {
    const env = machEnv({ PATH: `${SCCACHE_DIR}:/usr/bin` }, "/tmp/shim", HOME, () => true);
    expect(env.PATH).toBe(`/tmp/shim:${SCCACHE_DIR}:/usr/bin`);
  });
});
