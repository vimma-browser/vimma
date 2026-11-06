import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-dir.mjs";
import { exitCode, formatReport, githubAnnotations, runScenarios } from "../runner.mjs";

/** @param {string} name @param {object} [over] */
const scn = (name, over = {}) => ({
  name,
  description: name,
  steps: [{ "assert-state": { mode: "insert" } }],
  ...over,
});

/**
 * A session factory over a scripted fake ctl; records launches and teardowns.
 * @param {Record<string, object>} [statesByName]
 */
function sessions(statesByName = {}) {
  /** @type {string[]} */
  const events = [];
  return {
    events,
    /** @param {{ name: string }} s */
    startSession: async (s) => {
      events.push(`launch ${s.name}`);
      if (s.name.includes("nolaunch")) throw new Error("no control socket within 30000 ms");
      const state = statesByName[s.name] ?? { mode: "insert" };
      return {
        ctl: {
          state: async () => state,
          sendKeys: async () => {},
          open: async () => "2",
        },
        screenshot: async () => {},
        teardown: async () => void events.push(`teardown ${s.name}`),
      };
    },
  };
}

describe("runScenarios", () => {
  it("passes, fails with the step, and tears every session down", async () => {
    const { events, startSession } = sessions({ "m0-bad": { mode: "help" } });
    const results = await runScenarios([scn("m0-good"), scn("m0-bad")], { startSession });
    expect(results.map((r) => r.status)).toEqual(["pass", "fail"]);
    expect(results[1]?.error).toMatch(/step 1 \(assert-state\)/);
    expect(events).toEqual([
      "launch m0-good",
      "teardown m0-good",
      "launch m0-bad",
      "teardown m0-bad",
    ]);
    expect(exitCode(results)).toBe(1);
  });

  // A browser that crashed fails the step first; why it crashed comes from the teardown.
  it("adds a teardown's error to a failed step's, keeping the step's first", async () => {
    const results = await runScenarios([scn("m0-crash")], {
      startSession: async () => ({
        ctl: {
          state: async () => ({ mode: "help" }),
          sendKeys: async () => {},
          open: async () => "2",
        },
        screenshot: async () => {},
        teardown: async () => {
          throw new Error("the browser died (SIGSEGV)");
        },
      }),
    });
    expect(results[0]?.status).toBe("fail");
    expect(results[0]?.error).toMatch(/^step 1 \(assert-state\)[^]*\nteardown: the browser died/);
  });

  it("hands the session's profile to the steps (wait-for-profile-file)", async () => {
    const profile = tempDir("vimma-e2e-runner-");
    writeFileSync(join(profile, "search.json.mozlz4"), "");
    const { startSession } = sessions();
    const [r] = await runScenarios(
      [scn("m0-file", { steps: [{ "wait-for-profile-file": "search.json.mozlz4" }] })],
      { startSession: async (s, o) => ({ ...(await startSession(s, o)), profile }) },
    );
    expect(r).toMatchObject({ status: "pass" });
  });

  it("reports a launch failure as a failure of that scenario", async () => {
    const { startSession } = sessions();
    const [r] = await runScenarios([scn("m0-nolaunch")], { startSession });
    expect(r).toMatchObject({ status: "fail" });
    expect(r?.error).toMatch(/launch: no control socket/);
  });

  it("times a scenario out and still tears it down", async () => {
    const { events, startSession } = sessions({ "m0-slow": { mode: "insert" } });
    const results = await runScenarios(
      [
        scn("m0-slow", {
          timeoutSeconds: 0.3,
          steps: [{ "wait-for-state": { mode: "help" }, timeoutSeconds: 30 }],
        }),
      ],
      { startSession, pollMs: 10 },
    );
    expect(results[0]).toMatchObject({ status: "timeout" });
    expect(results[0]?.error).toMatch(/0\.3 s/);
    expect(events).toContain("teardown m0-slow");
    expect(exitCode(results)).toBe(1);
  });

  it("reports pending scenarios without launching them, and never as passed", async () => {
    const { events, startSession } = sessions();
    const results = await runScenarios([scn("m0-wip", { pending: "needs the control server" })], {
      startSession,
    });
    expect(results).toEqual([
      expect.objectContaining({
        name: "m0-wip",
        status: "pending",
        error: "needs the control server",
      }),
    ]);
    expect(events).toEqual([]);
    expect(exitCode(results)).toBe(0);
    expect(formatReport(results)).toMatch(
      /PENDING\s+m0-wip[^]*needs the control server[^]*0 passed, 0 failed, 1 pending/,
    );
  });

  it("runs a pending scenario with runPending", async () => {
    const { events, startSession } = sessions();
    const results = await runScenarios([scn("m0-wip", { pending: "x" })], {
      startSession,
      runPending: true,
    });
    expect(results[0]?.status).toBe("pass");
    expect(events).toEqual(["launch m0-wip", "teardown m0-wip"]);
  });

  it("skips what does not fit the total budget and fails the run", async () => {
    const { events, startSession } = sessions();
    let t = 0;
    const now = () => t;
    const slowStart = async (/** @type {{ name: string }} */ s) => {
      t += 4000;
      return startSession(s);
    };
    const results = await runScenarios([scn("m0-a"), scn("m0-b")], {
      startSession: slowStart,
      budgetMs: 3000,
      now,
    });
    expect(results.map((r) => r.status)).toEqual(["pass", "skipped"]);
    expect(results[1]?.error).toMatch(/budget/);
    expect(events).toEqual(["launch m0-a", "teardown m0-a"]);
    expect(exitCode(results)).toBe(1);
  });

  it("caps a scenario's timeout at what is left of the budget", async () => {
    const { startSession } = sessions();
    const results = await runScenarios(
      [
        scn("m0-slow", {
          timeoutSeconds: 60,
          steps: [{ "wait-for-state": { mode: "help" }, timeoutSeconds: 60 }],
        }),
      ],
      { startSession, budgetMs: 300, pollMs: 10 },
    );
    expect(results[0]).toMatchObject({ status: "timeout" });
  });

  // Timeouts must be hard: a hanging launch or vimma-ctl must not overrun.
  it("aborts a hanging launch at the timeout and returns on time", async () => {
    /** @type {AbortSignal[]} */
    const signals = [];
    const started = Date.now();
    const results = await runScenarios([scn("m0-hang", { timeoutSeconds: 0.3 })], {
      startSession: (_s, { signal }) => {
        signals.push(signal);
        return new Promise(() => {}); // never resolves, even when aborted
      },
      settleMs: 200,
    });
    expect(results[0]).toMatchObject({ status: "timeout" });
    expect(signals[0]?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("tears down a session that arrives after the timeout", async () => {
    /** @type {string[]} */
    const events = [];
    const results = await runScenarios([scn("m0-late", { timeoutSeconds: 0.2 })], {
      startSession: () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ctl: { state: async () => ({}), sendKeys: async () => {}, open: async () => "" },
                screenshot: async () => {},
                teardown: async () => void events.push("teardown"),
              }),
            500,
          ),
        ),
      settleMs: 50,
    });
    expect(results[0]?.status).toBe("timeout");
    await new Promise((r) => setTimeout(r, 600));
    expect(events).toEqual(["teardown"]);
  });

  it("does not wait on a step that ignores the abort, and still tears down", async () => {
    /** @type {string[]} */
    const events = [];
    const started = Date.now();
    const results = await runScenarios([scn("m0-stuck", { timeoutSeconds: 0.3 })], {
      startSession: async () => ({
        ctl: {
          state: () => new Promise(() => {}),
          sendKeys: async () => {},
          open: async () => "",
        },
        screenshot: async () => {},
        teardown: async () => void events.push("teardown"),
      }),
      settleMs: 200,
    });
    expect(results[0]?.status).toBe("timeout");
    expect(events).toEqual(["teardown"]);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("an empty selection is not a pass", () => {
    expect(exitCode([])).toBe(1);
  });
});

describe("report", () => {
  const results = [
    { name: "m0-a", status: "pass", ms: 1200 },
    { name: "issue-7-x", status: "fail", ms: 300, error: "step 2 (keys): boom" },
    { name: "m1-b", status: "pending", ms: 0, error: "needs the server" },
  ];
  it("lists each scenario and the totals", () => {
    const text = formatReport(/** @type {any} */ (results));
    expect(text).toMatch(/PASS\s+m0-a\s+1\.2 s/);
    expect(text).toMatch(/FAIL\s+issue-7-x[^]*step 2 \(keys\): boom/);
    expect(text).toMatch(/1 passed, 1 failed, 1 pending/);
  });
  it("emits GitHub annotations: errors for failures, a notice for pending", () => {
    expect(githubAnnotations(/** @type {any} */ (results))).toEqual([
      "::error title=e2e issue-7-x::step 2 (keys): boom",
      "::notice title=e2e pending::m1-b is pending, not run and not passed: needs the server",
    ]);
  });
});
