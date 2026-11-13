// The driver runs the real vimma-ctl (dogfooding it) against the fake control server. Without
// a built vimma-ctl these tests are skipped locally, never in CI: e2e.yml sets E2E_REQUIRE_CTL.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ctl, CtlError, classify, findVimmaCtl } from "../driver.mjs";
import { startFakeServer } from "./fake-server.mjs";

describe("classify (vimma-ctl exit codes, spec m0-control-protocol)", () => {
  it.each([
    [1, "vimma-ctl: invalid-args: bad url\n", { kind: "server", code: "invalid-args" }],
    [2, "vimma-ctl: missing command\n", { kind: "usage", code: null }],
    [
      3,
      "vimma-ctl: Vimma is not running (or the control socket is off): …\n",
      { kind: "not-running", code: null },
    ],
    [
      3,
      "vimma-ctl: Vimma's control socket is busy (busy: 8 open); try again\n",
      { kind: "busy", code: "busy" },
    ],
    [
      4,
      "vimma-ctl: authentication failed: unauthorized: bad token\n",
      { kind: "auth", code: "unauthorized" },
    ],
    [5, "vimma-ctl: protocol error: connection closed\n", { kind: "protocol", code: null }],
    [null, "", { kind: "spawn", code: null }],
  ])("exit %s → %o", (exit, stderr, want) => {
    expect(classify(exit, stderr)).toEqual(want);
  });
});

describe("findVimmaCtl", () => {
  /** @param {string[]} present */
  const exists = (present) => (/** @type {string} */ p) => present.includes(p);
  const root = "/repo/";
  it("takes the flag, then VIMMA_CTL, then a cargo build (release before debug)", () => {
    expect(findVimmaCtl({ flag: "/f", root, exists: exists(["/f"]) })).toBe("/f");
    expect(findVimmaCtl({ env: { VIMMA_CTL: "/e" }, root, exists: exists(["/e"]) })).toBe("/e");
    const rel = "/repo/tools/vimma-ctl/target/release/vimma-ctl";
    const dbg = "/repo/tools/vimma-ctl/target/debug/vimma-ctl";
    expect(findVimmaCtl({ root, exists: exists([rel, dbg]) })).toBe(rel);
    expect(findVimmaCtl({ root, exists: exists([dbg]) })).toBe(dbg);
  });
  it("says how to build it when it is missing", () => {
    expect(() => findVimmaCtl({ root, exists: exists([]) })).toThrow(/cargo build --locked/);
    expect(() => findVimmaCtl({ flag: "/nope", root, exists: exists([]) })).toThrow(/\/nope/);
  });
});

/** @type {string | null} */
let bin = null;
try {
  bin = findVimmaCtl({ env: process.env });
} catch (e) {
  if (process.env.E2E_REQUIRE_CTL) throw e;
}

describe.skipIf(!bin)(
  `Ctl against the fake server${bin ? "" : " (skipped: no vimma-ctl built)"}`,
  () => {
    /** @type {string} */
    let profile;
    /** @type {import("./fake-server.mjs").FakeServer} */
    let fake;
    /** @type {Ctl} */
    let ctl;
    beforeEach(async () => {
      profile = mkdtempSync(join(tmpdir(), "vimma-e2e-ctl-"));
      fake = await startFakeServer(profile);
      ctl = new Ctl({ bin: /** @type {string} */ (bin), profile, timeoutSecs: 2 });
    });
    afterEach(async () => {
      await fake.close().catch(() => {});
      rmSync(profile, { recursive: true, force: true });
    });

    it("reads state as JSON, sends keys and opens tabs", async () => {
      expect(await ctl.state()).toMatchObject({ mode: "insert", tabs: [{ url: "about:blank" }] });
      await ctl.sendKeys("ctrl+b ?");
      expect((await ctl.state()).mode).toBe("help");
      expect(await ctl.open("about:blank")).toBe("2");
      expect(fake.requests.map((r) => r.command)).toEqual(["state", "send-keys", "state", "open"]);
      expect(fake.requests[1]?.args).toEqual({ keys: "ctrl+b ?" });
    });

    it("ready() retries while the server is busy, then succeeds", async () => {
      fake.options.busyConnections = 2;
      await expect(ctl.ready({ timeoutMs: 5000, intervalMs: 50 })).resolves.toMatchObject({
        mode: "insert",
      });
      expect(fake.connections).toBe(3);
    });

    it("ready() gives up at its deadline with the last error", async () => {
      fake.options.busyConnections = 1000;
      await expect(ctl.ready({ timeoutMs: 600, intervalMs: 50 })).rejects.toThrow(/busy/);
    });

    it("ready() does not retry an authentication failure", async () => {
      fake.options.rejectAuth = true;
      const err = await ctl.ready({ timeoutMs: 5000, intervalMs: 50 }).catch((e) => e);
      expect(err).toBeInstanceOf(CtlError);
      expect(err).toMatchObject({ kind: "auth", code: "unauthorized", exitCode: 4 });
      expect(fake.connections).toBe(1);
    });

    it("commands are never retried: busy fails the call", async () => {
      fake.options.busyConnections = 1;
      await expect(ctl.state()).rejects.toMatchObject({ kind: "busy" });
      expect(fake.connections).toBe(1);
    });

    it("reports the server gone (stale discovery file) as not-running, once", async () => {
      await fake.close({ keepFile: true });
      const err = await ctl.sendKeys("esc").catch((e) => e);
      expect(err).toMatchObject({ kind: "not-running", exitCode: 3 });
      expect(err.message).toMatch(/send-keys[^]*not running/);
    });

    it("reports a connection dropped mid-reply as a protocol error", async () => {
      fake.options.dropOn = "state";
      await expect(ctl.state()).rejects.toMatchObject({ kind: "protocol", exitCode: 5 });
    });

    it("keeps the server's error code", async () => {
      fake.options.errorOn = { open: "invalid-args" };
      await expect(ctl.open("about:blank")).rejects.toMatchObject({
        kind: "server",
        code: "invalid-args",
      });
    });

    // The server answers `failed: no browser window` until its first window exists; without
    // the retry, ~70 % of runs failed at 0.7 s.
    it("ready() retries `no browser window` while the server starts up", async () => {
      fake.options.errorOn = { state: "failed" };
      fake.options.errorMessage = "no browser window";
      fake.options.errorTimes = 3;
      await expect(ctl.ready({ timeoutMs: 5000, intervalMs: 20 })).resolves.toMatchObject({
        mode: "insert",
      });
      expect(fake.requests.filter((r) => r.command === "state")).toHaveLength(4);
    });

    it("ready() does not retry any other `failed` error", async () => {
      fake.options.errorOn = { state: "failed" };
      fake.options.errorMessage = "no tab";
      await expect(ctl.ready({ timeoutMs: 5000, intervalMs: 20 })).rejects.toMatchObject({
        kind: "server",
        code: "failed",
      });
      expect(fake.requests).toHaveLength(1);
    });

    it("state() alone never retries `no browser window`", async () => {
      fake.options.errorOn = { state: "failed" };
      fake.options.errorMessage = "no browser window";
      await expect(ctl.state()).rejects.toMatchObject({ kind: "server", code: "failed" });
      expect(fake.requests).toHaveLength(1);
    });

    it("an abort signal kills a hanging vimma-ctl at once", async () => {
      fake.options.hangOn = "state";
      const controller = new AbortController();
      const slow = new Ctl({
        bin: /** @type {string} */ (bin),
        profile,
        timeoutSecs: 60,
        signal: controller.signal,
      });
      const pending = slow.state().catch((e) => e);
      setTimeout(() => controller.abort(), 200);
      const started = Date.now();
      expect(await pending).toMatchObject({ kind: "aborted" });
      expect(Date.now() - started).toBeLessThan(2000);
      await expect(slow.ready({ timeoutMs: 5000 })).rejects.toMatchObject({ kind: "aborted" });
    });

    it("reports a missing binary as a spawn error", async () => {
      const broken = new Ctl({ bin: join(profile, "no-such-ctl"), profile });
      await expect(broken.state()).rejects.toMatchObject({ kind: "spawn" });
    });
  },
);
