/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A task's budget (docs/specs/builtin-agent.md B10, Behaviour 34-35). Steps are tool calls,
// since those are what the user sees; tokens are what the provider reports, or an estimate;
// cost exists only with the prices the user entered, because providers return none. The loop
// checks it in code, so nothing the model writes raises it.
//
// An agent CLI's task (docs/specs/builtin-agent-cli.md C10, C13) counts the steps that reach the
// gate, the tokens the CLI reports, and wall-clock time against its `max_minutes`, because a CLI
// can spend time and money on its own tools without a step Vimma counts. The cost a CLI reports
// is its own estimate at list prices, so it is shown and never stops the task.

/** @typedef {{ maxSteps: number, maxTokens: number, maxCost: number }} Limits */
/** @typedef {{ priceIn?: number, priceOut?: number }} Prices  per million tokens */
/**
 * @typedef {{ limit: "steps" | "tokens" | "cost" | "minutes", used: number, max: number }}
 *   Exceeded
 */
/** @typedef {{ cli: string, maxMinutes: number, start?: number }} CliRun */

/**
 * `[agent]`'s defaults (docs/agent-bench.md): a scripted agent on the shortest path needs 51
 * steps and 490,000 tokens for a ten-item list, and every measured model took detours.
 */
export const DEFAULT_LIMITS = Object.freeze({ maxSteps: 100, maxTokens: 2_000_000, maxCost: 2 });

const MINUTE_MS = 60_000;

export class Budget {
  /** @param {Partial<Limits>} [limits] @param {Prices} [prices] @param {CliRun} [run] */
  constructor(limits = {}, prices = {}, run) {
    /** @type {Limits} */
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.prices =
      typeof prices.priceIn === "number" && typeof prices.priceOut === "number"
        ? { priceIn: prices.priceIn, priceOut: prices.priceOut }
        : null;
    this.steps = 0;
    this.input = 0;
    this.output = 0;
    this.estimated = false;
    /** What was used before the last `renew`, so a continued task gets the same budget again. */
    this.base = { steps: 0, tokens: 0, cost: 0 };
    /** An agent CLI's run: its name, its time limit and when it started. */
    this.cli = run
      ? { cli: run.cli, maxMinutes: run.maxMinutes, start: run.start ?? Date.now() }
      : null;
    /** Whether the CLI reported tokens; its last reported cost (a run's total so far). */
    this.tokensReported = false;
    /** @type {number | null} */
    this.reportedCost = null;
  }

  step() {
    this.steps++;
  }

  /** @param {{ input: number, output: number, estimated: boolean }} usage */
  addUsage({ input, output, estimated }) {
    this.input += input;
    this.output += output;
    this.estimated ||= estimated;
    this.tokensReported = true;
  }

  /**
   * The cost an agent CLI reported for its run so far: shown, never a limit (C13).
   * @param {number} usd
   */
  reportCost(usd) {
    this.reportedCost = usd;
  }

  get tokens() {
    return this.input + this.output;
  }

  /** The cost so far in the user's currency, or null for a provider without prices. */
  cost() {
    if (!this.prices) return null;
    return (this.input * this.prices.priceIn + this.output * this.prices.priceOut) / 1e6;
  }

  /** Whole minutes an agent CLI's run has taken, or null for a model's task. @param {number} now */
  minutes(now) {
    return this.cli ? Math.floor((now - this.cli.start) / MINUTE_MS) : null;
  }

  /** @param {number} [now] @returns {Exceeded | null} */
  exceeded(now = Date.now()) {
    const steps = this.steps - this.base.steps;
    if (steps >= this.limits.maxSteps)
      return { limit: "steps", used: steps, max: this.limits.maxSteps };
    const tokens = this.tokens - this.base.tokens;
    if (tokens >= this.limits.maxTokens)
      return { limit: "tokens", used: tokens, max: this.limits.maxTokens };
    const cost = this.cost();
    if (cost !== null && cost - this.base.cost >= this.limits.maxCost)
      return { limit: "cost", used: cost - this.base.cost, max: this.limits.maxCost };
    const minutes = this.minutes(now);
    if (this.cli && minutes !== null && minutes >= this.cli.maxMinutes)
      return { limit: "minutes", used: minutes, max: this.cli.maxMinutes };
    return null;
  }

  canStep() {
    return this.exceeded() === null;
  }

  /** `continue`: the same budget again, from what is used now. */
  renew() {
    this.base = { steps: this.steps, tokens: this.tokens, cost: this.cost() ?? 0 };
  }

  /**
   * For the status bar: `◇ built-in 14/60 · 212k tok`, `~` when estimated; an agent CLI's also
   * its name, its reported cost and its minutes.
   * @param {number} [now]
   */
  status(now = Date.now()) {
    return {
      steps: this.steps,
      maxSteps: this.limits.maxSteps,
      tokens: this.tokens,
      estimated: this.estimated,
      cost: this.cost(),
      ...(this.cli
        ? {
            cli: this.cli.cli,
            tokensReported: this.tokensReported,
            reportedCost: this.reportedCost,
            minutes: /** @type {number} */ (this.minutes(now)),
          }
        : {}),
    };
  }
}

const KEYS = {
  steps: "[agent] max_steps",
  tokens: "[agent] max_tokens",
  cost: "[agent] max_cost",
  minutes: "max_minutes",
};

/**
 * The transcript's line for a task stopped at its budget (Behaviour 34).
 * @param {Exceeded} e
 */
export function budgetLimitText(e) {
  const used = e.limit === "cost" ? `cost ${e.used.toFixed(2)}` : `${e.used} ${e.limit}`;
  return `stopped: ${used}, the limit of ${KEYS[e.limit]}`;
}
