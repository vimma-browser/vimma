#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The built-in agent's model test bench (docs/specs/builtin-agent.md B14, "The bench"): vimma-core's
 * model loop, run in Node against `vimma-ctl mcp` on a real Vimma build under Xvfb, shopping
 * the fixed lists in the local bench shop. Results: docs/agent-bench.md.
 *
 *   npm run agent-bench -- [--provider scripted|openai|anthropic] [--model <name>]
 *     [--endpoint <url>] [--key-env <VAR>] [--vision] [--num-ctx <tokens>]
 *     [--lists L01,L03] [--runs N] [--max-steps N] [--max-tokens N] [--timeout-minutes N]
 *     [--artifact | --build <path>] [--vimma-ctl <path>] [--out results.json] [--check] [--keep]
 *     [--shots <dir>] [--floor search|product] [--pace-ms N] [--keep-results N]
 *
 * --provider scripted (the default) needs no model and no network: a script does each list the
 * shortest way a model could, which CI runs with --check (exit 1 unless every run is complete
 * and safe). --floor search (the default) opens each product's search results by URL with their
 * elements and clicks the listing's basket button; --floor product, the earlier floor, opens each
 * product's page by its URL, for comparison. --pace-ms makes each scripted turn take that long,
 * as a model's does: unpaced, a list of more than nine items is refused by the open rate
 * (3000 keeps every list under it). --keep-results is `[agent] keep_results`: how many of the
 * latest tool results a request carries whole (by default the built-in agent's: 20 for a provider
 * on this machine, the scripted one included, and 6 for a hosted one; 0 sends every result whole,
 * as before docs/specs/agent-speed.md S5).
 * --provider openai talks to an OpenAI-compatible server (default http://127.0.0.1:11434/v1,
 * Ollama); --num-ctx makes an Ollama model with that context length first. --provider anthropic
 * reads its key from the environment variable --key-env names. Every run is one `vimma-ctl mcp`
 * connection, given a grant as a task sent with Enter will be, with every checkpoint answered no.
 * --shots saves screenshots of the Xvfb screen: MCP turned on, the grant's question, and each
 * question the answerer answers.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cpus, release, totalmem } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { keepResultsFor } from "../../packages/vimma-core/src/agent-loop.mjs";
import { agentTools, AGENT_INSTRUCTIONS } from "../../packages/vimma-core/src/agent-tools.mjs";
import { ControlSessions } from "../e2e/control-client.mjs";
import { findVimmaCtl } from "../e2e/driver.mjs";
import { findBuild, launch, quitBrowser } from "../e2e/launcher.mjs";
import { encodePng } from "../e2e/png.mjs";
import { capture } from "../e2e/screenshot.mjs";
import { formatBreakdown } from "./breakdown.mjs";
import { httpFetch } from "./http-fetch.mjs";
import { loadLists } from "./lists.mjs";
import { McpClient } from "./mcp-client.mjs";
import * as ollama from "./ollama.mjs";
import { answerer, grantSession, parseArgs, runOne } from "./run.mjs";
import { formatSummary } from "./score.mjs";
import { SCRIPTED_PROVIDER, scriptedFetch, shopper } from "./scripted.mjs";
import { OFFLINE_PREFS } from "../sites/sites.mjs";
import { startShop } from "./shop.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** Prefs for the bench's throwaway profile, beside the e2e harness's own. */
const PREFS = {
  // Only 127.0.0.1 and localhost are reached (the site suite's offline prefs): a model that
  // makes up a URL, or follows an injected one elsewhere, loads nothing off this machine.
  ...OFFLINE_PREFS,
  // A run waits for a model for minutes between keys; the held connection that answers
  // questions must outlive that (the default idle limit is 60 s).
  "vimma.control.idleTimeoutMs": 3_600_000,
  // A question the answerer missed is denied after 30 s rather than the default 50 s.
  "vimma.mcp.askTimeoutMs": 30_000,
  // Text in the address bar is never sent to a search engine: the bench reaches local servers
  // and nothing else.
  "keyword.enabled": false,
  "browser.search.suggest.enabled": false,
};

/** @param {string} s */
const log = (s) => process.stderr.write(`agent-bench: ${s}\n`);

function hardware() {
  const cpu = cpus()[0]?.model.trim() ?? "unknown CPU";
  return `${cpu}, ${cpus().length} threads, ${Math.round(totalmem() / 2 ** 30)} GiB RAM, Linux ${release()}`;
}

function commit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO }).toString().trim();
  } catch {
    return "unknown";
  }
}

/** @param {any[]} items */
const textOf = (items) =>
  items
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    const doc = /\/\*\*([^]*?)\*\//.exec(readFileSync(fileURLToPath(import.meta.url), "utf8"));
    process.stdout.write(`${(doc?.[1] ?? "").replace(/^\s*\* ?/gm, "").trim()}\n`);
    return 0;
  }
  const all = loadLists();
  const lists = o.lists
    ? o.lists.map((id) => {
        const l = all.find((x) => x.id === id);
        if (!l) throw new Error(`no list ${id}; the lists are ${all.map((x) => x.id).join(", ")}`);
        return l;
      })
    : all;

  /** @type {import("../../packages/vimma-core/src/agent-providers.mjs").Provider} */
  let provider = SCRIPTED_PROVIDER;
  let key = "";
  /** @type {Record<string, any>} */
  const meta = {
    provider: o.provider,
    hardware: hardware(),
    commit: commit(),
  };
  if (o.provider === "scripted") Object.assign(meta, { floor: o.floor, paceMs: o.paceMs });
  if (o.provider !== "scripted") {
    let model = /** @type {string} */ (o.model);
    const endpoint = /** @type {string} */ (o.endpoint);
    const isOllama = o.provider === "openai" && /:11434(\/|$)/.test(endpoint);
    if (o.numCtx) {
      if (!isOllama) throw new Error("--num-ctx sets an Ollama model's context length only");
      model = await ollama.withContext(endpoint, model, o.numCtx);
      log(`model with num_ctx ${o.numCtx}: ${model}`);
    }
    provider = {
      kind: /** @type {"openai" | "anthropic"} */ (o.provider),
      endpoint,
      model,
      vision: o.vision,
    };
    if (o.keyEnv) key = process.env[o.keyEnv] ?? "";
    Object.assign(meta, { model: o.model, endpoint, vision: o.vision });
    if (isOllama) Object.assign(meta, await ollama.describe(endpoint, model));
  }
  meta.keepResults = keepResultsFor(provider, o.keepResults);
  const tools = agentTools({ vision: provider.vision ?? false });
  const limits = {
    ...(o.maxSteps ? { maxSteps: o.maxSteps } : {}),
    ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}),
  };
  meta.limits = limits;

  const shop = await startShop();
  const build = findBuild({ build: o.build ?? undefined, artifact: o.artifact, env: process.env });
  const ctlBin = findVimmaCtl({ flag: o.vimmaCtl ?? undefined, env: process.env });
  log(`build ${build.binary}, vimma-ctl ${ctlBin}, shop ${shop.base}`);
  const session = await launch({ build, xvfb: true, prefs: PREFS, keep: o.keep, log });
  const sessions = new ControlSessions({ profile: session.profile, bin: ctlBin });
  let shotCount = 0;
  const shot = async (/** @type {string} */ name) => {
    if (!o.shots || !session.display) return;
    mkdirSync(o.shots, { recursive: true });
    const file = join(o.shots, `${String(++shotCount).padStart(3, "0")}-${name}.png`);
    writeFileSync(file, encodePng(await capture(session.display.fbFile)));
  };
  /** @type {any[]} */
  const runs = [];
  try {
    // Held before MCP is on, so keys sent through it never ask (vimma-mcp decision 29 C).
    await sessions.hold();
    // Keys go to a loaded page of the main workspace, never to the address bar that a blank
    // window focuses, where they would be typed as a search. Keys meant for a question that is
    // not up yet land on this page, where `n` and `a` do nothing.
    await sessions.held.open(shop.base);
    for (let i = 0; ; i++) {
      const state = await sessions.held.state();
      const tab = state.tabs?.find((/** @type {any} */ t) => t.selected);
      if (
        state.workspace === "main" &&
        tab?.url === shop.base &&
        !tab.loading &&
        state.mode === "normal"
      )
        break;
      if (i > 100)
        throw new Error(`the main workspace did not show the shop: ${JSON.stringify(state)}`);
      await sleep(200);
    }
    await sessions.held.sendKeys(": m c p space o n enter");
    await sleep(500);
    await shot("mcp-on-question");
    await sessions.held.sendKeys("y");
    await sleep(1500);
    await shot("mcp-on");
    const sendKeys = async (/** @type {string} */ k) => {
      await shot(`question-${k}`);
      await sessions.held.sendKeys(k);
    };

    for (const list of lists) {
      for (let n = 1; n <= o.runs; n++) {
        const mcp = new McpClient({ bin: ctlBin, profile: session.profile });
        try {
          await mcp.initialize();
          await grantSession({ call: () => mcp.callTool("vimma_tabs", {}), sendKeys });
          const answer = answerer({ sendKeys });
          const ticker = setInterval(() => void answer.tick().catch(() => {}), 250);
          const run = await runOne({
            list,
            shop,
            provider,
            fetch:
              o.provider === "scripted"
                ? scriptedFetch(shopper({ base: shop.base, list, path: o.floor }), {
                    paceMs: o.paceMs,
                  })
                : httpFetch,
            key,
            system: AGENT_INSTRUCTIONS,
            tools,
            runTool: answer.wrap((name, args, opts) => mcp.callTool(name, args, opts)),
            limits,
            keepResults: o.keepResults,
            timeoutMs: o.timeoutMinutes * 60_000,
            settleMs: 1000,
          }).finally(() => clearInterval(ticker));
          runs.push({ ...run, run: n });
          log(
            `${list.id} run ${n}: ${run.outcome}, ${run.complete ? "complete" : "incomplete"} ` +
              `(${run.correct}/${run.lines}), ${run.steps} steps, ${run.input + run.output} tokens, ` +
              `${Math.round(run.wallMs / 1000)} s${run.safe ? "" : ", UNSAFE"}`,
          );
          // The next run starts on an empty agent workspace.
          const tabs = textOf((await mcp.callTool("vimma_tabs", {})).content);
          for (const id of new Set([...tabs.matchAll(/"id":\s*"(\d+)"/g)].map((m) => m[1])))
            await mcp.callTool("vimma_close_tab", { tab: id });
        } finally {
          await mcp.close();
        }
      }
    }
    if (o.provider === "openai" && /:11434(\/|$)/.test(String(o.endpoint)))
      meta.loaded = await ollama.loaded(/** @type {string} */ (o.endpoint)).catch(() => null);
  } finally {
    const ctl = {
      state: () => sessions.held.state(),
      sendKeys: (/** @type {string} */ k) => sessions.held.sendKeys(k),
    };
    await quitBrowser({ ctl, child: session.child }).catch(() => false);
    sessions.close();
    await session.teardown();
    await shop.close();
  }

  const table = formatSummary(runs);
  process.stdout.write(`\n${JSON.stringify(meta)}\n\n${table}\n\n${formatBreakdown(runs)}\n`);
  if (o.out) writeFileSync(o.out, `${JSON.stringify({ meta, runs }, null, 2)}\n`);
  if (o.check) {
    const bad = runs.filter((r) => !r.complete || !r.safe || !r.checkpointAsked);
    if (bad.length) {
      log(`--check: ${bad.length} run(s) not complete, safe and stopped at the checkpoint`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      log(e instanceof Error ? (e.stack ?? e.message) : String(e));
      process.exit(1);
    },
  );
}
