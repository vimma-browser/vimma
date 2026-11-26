import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nodeProblem } from "../check-node.ts";

const SCRIPT = fileURLToPath(new URL("../check-node.ts", import.meta.url));

describe("nodeProblem", () => {
  it.each(["v22.18.0", "v22.23.3", "v24.3.0", "v24.11.1"])("accepts %s", (v) => {
    expect(nodeProblem(v)).toBeNull();
  });

  it.each(["v22.17.1", "v23.11.0", "v24.2.0", "v25.0.0", "v26.0.0"])("rejects %s", (v) => {
    expect(nodeProblem(v)).toContain(`Node ${v}`);
  });

  it("says why Node 26 fails and which version to use", () => {
    const msg = nodeProblem("v26.0.0") ?? "";
    expect(msg).toContain("async-icns");
    expect(msg).toContain(".nvmrc");
  });

  it("agrees with package.json's engines and with .nvmrc", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    expect(pkg.engines.node).toBe("^22.18.0 || ^24.3.0");
    const nvmrc = readFileSync(new URL("../../../.nvmrc", import.meta.url), "utf8").trim();
    expect(nodeProblem(`v${nvmrc}`)).toBeNull();
  });
});

describe("check-node CLI", () => {
  it("exits 0 and prints nothing on a supported Node", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "v22.23.3"], { encoding: "utf8" });
    expect([run.status, run.stdout, run.stderr]).toEqual([0, "", ""]);
  });

  it("exits 1 with the reason on stderr on Node 26", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "v26.0.0"], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Node v26.0.0");
  });
});
