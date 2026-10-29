// Issue #579 (docs/specs/mcp-forms.md F11, F12): after an agent's click or a fill's submission
// the call waits until the page has gone quiet, not a fixed second; a loaded page counts as
// ready at DOMContentLoaded and a short quiet period, not at its load event.
import { describe, expect, test } from "vitest";
import { AGENT_WAITS, quietVerdict } from "../src/agent-wait.mjs";

const STEP = { quiet: AGENT_WAITS.quiet, still: AGENT_WAITS.still, max: AGENT_WAITS.busy };

describe("the waits", () => {
  test("a quiet period of 200-300 ms, never longer than the fixed second it replaces", () => {
    expect(AGENT_WAITS.quiet).toBeGreaterThanOrEqual(200);
    expect(AGENT_WAITS.quiet).toBeLessThanOrEqual(300);
    expect(AGENT_WAITS.readyQuiet).toBeLessThanOrEqual(AGENT_WAITS.quiet);
  });

  test("a page that changed nothing yet waits past a hidden tab's one-second timer clamp", () => {
    // dom.min_background_timeout_value: a hidden tab's page timers fire at most once a second.
    expect(AGENT_WAITS.still).toBeGreaterThan(1000);
    expect(AGENT_WAITS.still).toBeLessThan(AGENT_WAITS.busy);
  });

  test("no wait is longer than the old worst case: a second's settle and a second's look", () => {
    expect(AGENT_WAITS.busy).toBeLessThanOrEqual(2000);
    expect(AGENT_WAITS.readyBusy).toBeLessThanOrEqual(AGENT_WAITS.busy);
  });
});

describe("quietVerdict", () => {
  test("a page that changed and then stayed still for the quiet period is quiet", () => {
    expect(quietVerdict({ elapsed: 300, sinceChange: 250, netBusy: false }, STEP)).toBe("quiet");
  });

  test("a page still changing keeps the wait going", () => {
    expect(quietVerdict({ elapsed: 300, sinceChange: 10, netBusy: false }, STEP)).toBe(null);
  });

  test("a request the step started keeps the wait going, even after a change", () => {
    expect(quietVerdict({ elapsed: 900, sinceChange: 800, netBusy: true }, STEP)).toBe(null);
  });

  test("a page that has changed nothing waits for the first change up to `still`", () => {
    expect(quietVerdict({ elapsed: 300, sinceChange: null, netBusy: false }, STEP)).toBe(null);
    expect(quietVerdict({ elapsed: STEP.still - 1, sinceChange: null, netBusy: false }, STEP)).toBe(
      null,
    );
    expect(quietVerdict({ elapsed: STEP.still, sinceChange: null, netBusy: false }, STEP)).toBe(
      "quiet",
    );
  });

  test("a page that never goes quiet ends the wait at `max`", () => {
    expect(quietVerdict({ elapsed: STEP.max, sinceChange: 0, netBusy: true }, STEP)).toBe("busy");
    expect(quietVerdict({ elapsed: STEP.max, sinceChange: null, netBusy: false }, STEP)).toBe(
      "busy",
    );
  });

  test("ready: the quiet period counts from DOMContentLoaded, with no wait for a first change", () => {
    const ready = { quiet: AGENT_WAITS.readyQuiet, still: 0, max: AGENT_WAITS.readyBusy };
    expect(quietVerdict({ elapsed: 50, sinceChange: 50, netBusy: false }, ready)).toBe(null);
    expect(
      quietVerdict(
        { elapsed: AGENT_WAITS.readyQuiet, sinceChange: AGENT_WAITS.readyQuiet, netBusy: false },
        ready,
      ),
    ).toBe("quiet");
  });

  test("bad input never holds a call: a non-finite elapsed time ends the wait", () => {
    expect(quietVerdict({ elapsed: NaN, sinceChange: null, netBusy: false }, STEP)).toBe("busy");
  });
});
