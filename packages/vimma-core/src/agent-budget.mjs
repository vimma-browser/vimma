/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A task's budget (docs/specs/builtin-agent.md B10, Behaviour 34-35). Steps are tool calls,
// since those are what the user sees; tokens are what the provider reports, or an estimate;
// cost exists only with the prices the user entered, because providers return none. The loop
// checks it in code, so nothing the model writes raises it.

/** @typedef {{ maxSteps: number, maxTokens: number, maxCost: number }} Limits */
/** @typedef {{ priceIn?: number, priceOut?: number }} Prices  per million tokens */
/** @typedef {{ limit: "steps" | "tokens" | "cost", used: number, max: number }} Exceeded */

/** `[agent]`'s defaults: about three times the 20 calls one three-item basket took. */
export const DEFAULT_LIMITS = Object.freeze({ maxSteps: 60, maxTokens: 1_000_000, maxCost: 2 });

export class Budget {
  /** @param {Partial<Limits>} [limits] @param {Prices} [prices] */
  constructor(limits = {}, prices = {}) {
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
  }

  step() {
    this.steps++;
  }

  /** @param {{ input: number, output: number, estimated: boolean }} usage */
  addUsage({ input, output, estimated }) {
    this.input += input;
    this.output += output;
    this.estimated ||= estimated;
  }

  get tokens() {
    return this.input + this.output;
  }

  /** The cost so far in the user's currency, or null for a provider without prices. */
  cost() {
    if (!this.prices) return null;
    return (this.input * this.prices.priceIn + this.output * this.prices.priceOut) / 1e6;
  }

  /** @returns {Exceeded | null} */
  exceeded() {
    const steps = this.steps - this.base.steps;
    if (steps >= this.limits.maxSteps)
      return { limit: "steps", used: steps, max: this.limits.maxSteps };
    const tokens = this.tokens - this.base.tokens;
    if (tokens >= this.limits.maxTokens)
      return { limit: "tokens", used: tokens, max: this.limits.maxTokens };
    const cost = this.cost();
    if (cost !== null && cost - this.base.cost >= this.limits.maxCost)
      return { limit: "cost", used: cost - this.base.cost, max: this.limits.maxCost };
    return null;
  }

  canStep() {
    return this.exceeded() === null;
  }

  /** `continue`: the same budget again, from what is used now. */
  renew() {
    this.base = { steps: this.steps, tokens: this.tokens, cost: this.cost() ?? 0 };
  }

  /** For the status bar: `◇ built-in 14/60 · 212k tok`, `~` when estimated. */
  status() {
    return {
      steps: this.steps,
      maxSteps: this.limits.maxSteps,
      tokens: this.tokens,
      estimated: this.estimated,
      cost: this.cost(),
    };
  }
}

const KEYS = { steps: "max_steps", tokens: "max_tokens", cost: "max_cost" };

/**
 * The transcript's line for a task stopped at its budget (Behaviour 34).
 * @param {Exceeded} e
 */
export function budgetLimitText(e) {
  const used = e.limit === "cost" ? `cost ${e.used.toFixed(2)}` : `${e.used} ${e.limit}`;
  return `stopped: ${used}, the limit of [agent] ${KEYS[e.limit]}`;
}
