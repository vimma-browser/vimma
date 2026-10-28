// docs/specs/builtin-agent.md B10, Behaviour 34-35: a task's budget of steps, tokens and cost,
// which the model cannot raise.
import { describe, expect, test } from "vitest";
import { Budget, DEFAULT_LIMITS, budgetLimitText } from "../src/agent-budget.mjs";

describe("Budget", () => {
  test("the defaults are those of [agent]", () => {
    expect(DEFAULT_LIMITS).toEqual({ maxSteps: 60, maxTokens: 1_000_000, maxCost: 2 });
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
      maxSteps: 60,
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
