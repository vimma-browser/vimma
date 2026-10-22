// npm run build (tools/build.mjs): which command it runs. The interpreter choice is in
// mach-python.test.mjs; nothing here builds.
import { describe, expect, it } from "vitest";
import { buildCommand } from "../build.mjs";

const ROOT = "/repo/";
const ENGINE = "/repo/engine/";
const PY = "/usr/bin/python3";

describe("buildCommand", () => {
  it("runs a full surfer build from the checkout by default", () => {
    expect(buildCommand([], ROOT, ENGINE, PY)).toEqual({
      command: "surfer",
      args: ["build"],
      cwd: ROOT,
      dryRun: false,
    });
  });

  it("passes --ui and other flags on to surfer build", () => {
    expect(buildCommand(["--ui"], ROOT, ENGINE, PY).args).toEqual(["build", "--ui"]);
  });

  it("runs ./mach build with the chosen interpreter for --mach", () => {
    expect(buildCommand(["--mach", "-j8"], ROOT, ENGINE, PY)).toEqual({
      command: PY,
      args: ["./mach", "build", "-j8"],
      cwd: ENGINE,
      dryRun: false,
    });
  });

  it("only reports the command for --dry-run", () => {
    const res = buildCommand(["--dry-run", "--ui"], ROOT, ENGINE, PY);
    expect(res.dryRun).toBe(true);
    expect(res.args).toEqual(["build", "--ui"]);
  });
});
