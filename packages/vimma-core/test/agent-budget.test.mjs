// docs/specs/builtin-agent.md B10, Behaviour 34-35: a task's budget of steps, tokens and cost,
// which the model cannot raise.
import { describe, expect, test } from "vitest";
import { Budget, DEFAULT_LIMITS, budgetLimitText } from "../src/agent-budget.mjs";

describe("Budget", () => {
  test("the defaults are those of [agent]", () => {
    expect(DEFAULT_LIMITS).toEqual({ maxSteps: 100, maxTokens: 2_000_000, maxCost: 2 });
    expect(new Budget().limits).toEqual(DEFAULT_LIMITS);
  });

  test("a task stops at max_steps", () => {
    const b = new Budget({ maxSteps: 2 });
    expect(b.canStep()).toBe(true);
    b.step();
    expect(b.canStep()).toBe(true);
    b.step();
    expect(b.canStep()).toBe(false);
    expect(b.exceeded()).toEqual({ limit: "steps", used: 2, max: 2 });
  });

  test("a task stops at max_tokens, input and output summed over its requests", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.addUsage({ input: 600, output: 300, estimated: false });
    expect(b.exceeded()).toBe(null);
    expect(b.canStep()).toBe(true);
    b.addUsage({ input: 50, output: 50, estimated: false });
    expect(b.exceeded()).toEqual({ limit: "tokens", used: 1000, max: 1000 });
    expect(b.canStep()).toBe(false);
  });

  test("a task stops at max_cost for a provider with prices", () => {
    const b = new Budget({ maxCost: 0.01 }, { priceIn: 3, priceOut: 15 });
    b.addUsage({ input: 1000, output: 200, estimated: false });
    expect(b.cost()).toBeCloseTo(0.006, 10);
    expect(b.exceeded()).toBe(null);
    b.addUsage({ input: 1000, output: 100, estimated: false });
    expect(b.cost()).toBeCloseTo(0.0105, 10);
    expect(b.exceeded()).toMatchObject({ limit: "cost", max: 0.01 });
  });

  test("cost is computed only with prices", () => {
    for (const prices of [undefined, {}, { priceIn: 3 }, { priceOut: 15 }]) {
      const b = new Budget({ maxCost: 0 }, prices);
      b.addUsage({ input: 10_000, output: 10_000, estimated: false });
      expect(b.cost()).toBe(null);
      expect(b.exceeded()).toBe(null);
    }
    const free = new Budget({}, { priceIn: 0, priceOut: 0 });
    free.addUsage({ input: 10, output: 10, estimated: false });
    expect(free.cost()).toBe(0);
  });

  test("an estimate marks the counts", () => {
    const b = new Budget();
    b.addUsage({ input: 1, output: 1, estimated: false });
    expect(b.status().estimated).toBe(false);
    b.addUsage({ input: 1, output: 1, estimated: true });
    expect(b.status()).toEqual({
      steps: 0,
      maxSteps: 100,
      tokens: 4,
      estimated: true,
      cost: null,
    });
  });

  test("continue grants the same budget again", () => {
    const b = new Budget({ maxSteps: 2, maxTokens: 100 }, { priceIn: 1, priceOut: 1 });
    b.step();
    b.step();
    b.addUsage({ input: 90, output: 20, estimated: false });
    expect(b.canStep()).toBe(false);
    b.renew();
    expect(b.canStep()).toBe(true);
    expect(b.exceeded()).toBe(null);
    // The totals stay, for the status bar and the task summary.
    expect(b.status()).toMatchObject({ steps: 2, tokens: 110 });
    b.step();
    b.step();
    expect(b.exceeded()).toEqual({ limit: "steps", used: 2, max: 2 });
  });

  test("the transcript names the limit", () => {
    expect(budgetLimitText({ limit: "steps", used: 60, max: 60 })).toBe(
      "stopped: 60 steps, the limit of [agent] max_steps",
    );
    expect(budgetLimitText({ limit: "tokens", used: 1_000_200, max: 1_000_000 })).toBe(
      "stopped: 1000200 tokens, the limit of [agent] max_tokens",
    );
    expect(budgetLimitText({ limit: "cost", used: 2.0134, max: 2 })).toBe(
      "stopped: cost 2.01, the limit of [agent] max_cost",
    );
  });
});

// docs/specs/builtin-agent-cli.md C10, C13, Behaviour 14-16: an agent CLI's task. Steps are the
// gate's count; tokens and cost are the CLI's own report; wall-clock time is Vimma's.
describe("an agent CLI's budget", () => {
  const MIN = 60_000;
  const cli = (/** @type {Partial<import("../src/agent-budget.mjs").Limits>} */ limits = {}) =>
    new Budget(limits, {}, { cli: "claude-code", maxMinutes: 30, start: 0 });

  test("a cli task stops at max_minutes", () => {
    const b = cli();
    expect(b.exceeded(29 * MIN)).toBe(null);
    expect(b.exceeded(30 * MIN)).toEqual({ limit: "minutes", used: 30, max: 30 });
    expect(budgetLimitText({ limit: "minutes", used: 30, max: 30 })).toBe(
      "stopped: 30 minutes, the limit of max_minutes",
    );
    // A model provider's task has no time limit.
    expect(new Budget().exceeded(10_000 * MIN)).toBe(null);
  });

  test("reported cost is shown and max_cost does not stop a cli task", () => {
    const b = cli({ maxCost: 0.5 });
    b.reportCost(3.25);
    expect(b.exceeded(MIN)).toBe(null);
    expect(b.status(MIN)).toMatchObject({ cost: null, reportedCost: 3.25, cli: "claude-code" });
    // Each result reports the run's total so far: the last one counts, not their sum.
    b.reportCost(3.5);
    expect(b.status(MIN).reportedCost).toBe(3.5);
  });

  test("reported tokens count toward max_tokens", () => {
    const b = cli({ maxTokens: 1000 });
    b.addUsage({ input: 900, output: 99, estimated: false });
    expect(b.exceeded(MIN)).toBe(null);
    b.addUsage({ input: 1, output: 0, estimated: false });
    expect(b.exceeded(MIN)).toEqual({ limit: "tokens", used: 1000, max: 1000 });
    expect(b.status(MIN)).toMatchObject({ tokens: 1000, tokensReported: true });
  });

  test("steps are the gate's, counted as any provider's", () => {
    const b = cli({ maxSteps: 2 });
    b.step();
    b.step();
    expect(b.exceeded(MIN)).toEqual({ limit: "steps", used: 2, max: 2 });
  });

  test("no report shows steps and time only", () => {
    const b = cli();
    b.step();
    expect(b.status(6 * MIN + 1000)).toMatchObject({
      steps: 1,
      tokens: 0,
      tokensReported: false,
      reportedCost: null,
      minutes: 6,
    });
  });
});
