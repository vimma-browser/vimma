import { describe, expect, it } from "vitest";
import { evaluate, runJobs } from "./workflow-if.mjs";

// workflow-if.mjs evaluates job conditions as GitHub documents them, so that a workflow test can
// say which jobs an event starts.
const CONTEXT = {
  github: { event_name: "schedule", ref: "refs/heads/main" },
  vars: { ON: "true" },
  needs: { a: { result: "success", outputs: { x: "1", empty: "" } } },
  status: { success: true, failure: false, cancelled: false },
};

describe("evaluate", () => {
  it.each([
    ["github.event_name == 'schedule'", true],
    ["github.event_name == 'SCHEDULE'", true],
    ["github.event_name != 'schedule'", false],
    ["vars.ON == 'true' && vars.MISSING == 'true'", false],
    ["vars.MISSING == ''", true],
    ["needs.a.outputs.empty != ''", false],
    ["needs.a.outputs.x == '1' && needs.a.outputs.x", "1"],
    ["needs.b.outputs.x || 'fallback'", "fallback"],
    ["!(vars.ON == 'true') || github.ref == 'refs/heads/main'", true],
    ["!cancelled() && success() && !failure() && always()", true],
    ["${{ needs.a.outputs.x }}", "1"],
    ["'it''s'", "it's"],
  ])("%s is %j", (expression, value) => {
    expect(evaluate(expression, CONTEXT)).toEqual(value);
  });

  it("refuses what it cannot read rather than guess", () => {
    expect(() => evaluate("contains(github.ref, 'main')", CONTEXT)).toThrow();
    expect(() => evaluate("vars.ON ==", CONTEXT)).toThrow();
    expect(() => evaluate("vars.ON 'x'", CONTEXT)).toThrow();
  });
});

describe("runJobs", () => {
  const JOBS = new Map(
    Object.entries({
      first: { if: "vars.ON == 'true'" },
      second: { needs: "first", with: { id: "${{ needs.first.outputs.id }}" } },
      third: { needs: ["first", "second"], if: "!cancelled() && needs.second.result == 'skipped'" },
    }),
  );

  it("skips a job whose need was skipped, unless its condition names a status function", () => {
    const off = runJobs(JOBS, { github: {}, vars: {} });
    expect([...off].map(([id, j]) => [id, j.result])).toEqual([
      ["first", "skipped"],
      ["second", "skipped"],
      ["third", "success"],
    ]);
    const on = runJobs(JOBS, { github: {}, vars: { ON: "true" }, outputs: { first: { id: "7" } } });
    expect(on.get("second")).toEqual({ result: "success", with: { id: "7" } });
    expect(on.get("third")?.result).toBe("skipped");
  });

  it("ends a job as results says, and a cancelled job cancels the run", () => {
    const vars = { ON: "true" };
    const failed = runJobs(JOBS, { github: {}, vars, results: { first: "failure" } });
    expect([...failed].map(([, j]) => j.result)).toEqual(["failure", "skipped", "success"]);
    const stopped = runJobs(JOBS, { github: {}, vars, results: { first: "cancelled" } });
    expect([...stopped].map(([, j]) => j.result)).toEqual(["cancelled", "skipped", "skipped"]);
  });
});
