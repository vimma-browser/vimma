// The checks of one site (docs/specs/site-compat.md, decision 5), on a browser that sites.mjs
// has launched: keys and modes through vimma-ctl, everything else read over RDP with the probes.
// Results are written into `result` as they come, so a timed-out site keeps what it found.
import { setTimeout as sleep } from "node:timers/promises";
import { canScroll, chooseHintLink, reactionOf, scrollMovement } from "./analysis.mjs";
import { CONSENT_SELECTORS, REJECT_SOURCES, classifyPage } from "./classify.mjs";
import {
  chromeCloseFindbar,
  chromeFindStatus,
  chromeHints,
  chromeReadClipboard,
  chromeSetClipboard,
  chromeStatusbarMode,
  chromeTabBusy,
  chromeTakeErrors,
  chromeWatchErrors,
  contentActive,
  contentClickReject,
  contentClickables,
  contentExitFullscreen,
  contentFocusField,
  contentLinksAt,
  contentPageInfo,
  contentPickWord,
  contentPressKey,
  contentReaction,
  contentRecorder,
  contentScrollSnapshot,
  contentSnapshot,
  probe,
} from "./probes.mjs";
import { completeChecks, siteStatus, statusbarCheck } from "./results.mjs";
import { FOLLOW_TARGET, SNAPSHOT_CSP } from "./snapshot.mjs";

/** @typedef {import("./results.mjs").CheckResult} CheckResult */
/** @typedef {import("./results.mjs").SiteResult} SiteResult */
/** @typedef {import("./site-list.mjs").Site} Site */

/**
 * Vimma's single normal-mode keys (packages/vimma-core/src/defaults.mjs, `modal.normal`), pressed
 * for the page alone (contentPressKey) to see which ones the site uses itself.
 */
export const SHORTCUT_KEYS = Object.freeze(
  "j k h l d u f F / ? n N I v : t x b r H L p P G y g".split(" "),
);
export const LOAD_TIMEOUT_MS = 45_000;
const SETTLE_MS = 2000;
const MAX_FAILURE_SHOTS = 3;

/**
 * @typedef {object} Context
 * @property {{ state: () => Promise<Record<string, any>>, sendKeys: (keys: string) => Promise<void>,
 *   open: (url: string) => Promise<string> }} ctl
 * @property {import("./rdp.mjs").Rdp} rdp
 * @property {string} parent  the parent process's console actor
 * @property {(label: string) => Promise<string | null>} screenshot  returns the file name
 * @property {(line: string) => void} log
 */

/**
 * Poll `fn` until it returns a truthy value or `timeoutMs` passes; errors count as falsy.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ timeoutMs: number, intervalMs?: number }} options
 * @returns {Promise<T | null>}
 */
export async function poll(fn, { timeoutMs, intervalMs = 10 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/** The selected tab of a vimma-ctl state. @param {Record<string, any>} state */
const selectedTab = (state) => state.tabs?.find((/** @type {any} */ t) => t.selected) ?? null;

/** Probes in the selected tab, re-attaching after a navigation destroyed the target. */
class Tab {
  /** @param {Context} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {string | null} */
    this.actor = null;
  }

  reset() {
    this.actor = null;
  }

  /**
   * @param {Function} fn a content probe
   * @param {unknown} [arg]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<any>}
   */
  async eval(fn, arg, options) {
    for (let attempt = 0; ; attempt++) {
      try {
        if (!this.actor) {
          const tab = selectedTab(await this.ctx.ctl.state());
          if (!tab) throw new Error("no selected tab");
          this.actor = await this.ctx.rdp.tabConsole(Number(tab.id));
        }
        return JSON.parse(await this.ctx.rdp.evaluate(this.actor, probe(fn, arg), options));
      } catch (e) {
        this.actor = null;
        if (attempt >= 1) throw e;
      }
    }
  }
}

/**
 * Run every check on `site`, filling `result`. `offline`: the site is a snapshot (snapshot.mjs),
 * which has none of the site's scripts, so its shortcuts are not probed.
 * @param {Site} site
 * @param {Context} ctx
 * @param {SiteResult} result
 * @param {{ offline?: boolean }} [options]
 */
export async function runSite(site, ctx, result, { offline = false } = {}) {
  const { ctl, rdp, parent, log } = ctx;
  const tab = new Tab(ctx);
  /** @type {CheckResult[]} */
  const checks = (result.checks = []);
  const steps = (result.steps = []);
  let failureShots = 0;
  /** @param {Function} fn @param {unknown} [arg] */
  const chrome = async (fn, arg) => JSON.parse(await rdp.evaluate(parent, probe(fn, arg)));
  /** @param {CheckResult} c */
  const record = async (c) => {
    checks.push(c);
    log(`    ${c.id}: ${c.status}${c.reason ? ` (${c.reason})` : ""}`);
    if (c.status === "fail" && failureShots < MAX_FAILURE_SHOTS) {
      failureShots++;
      await shot(`fail-${c.id}`);
    }
  };
  /** @param {string} label */
  const shot = async (label) => {
    const file = await ctx.screenshot(label).catch(() => null);
    if (file) result.screenshots.push({ label, file });
  };
  /**
   * Wait for vimma-ctl's mode and the status bar to show `expected`; record the step.
   * @param {string} step
   * @param {string} expected
   */
  const expectMode = async (step, expected, timeoutMs = 1500) => {
    /** @type {string | null} */
    let state = null;
    /** @type {string | null} */
    let bar = null;
    const ok = await poll(
      async () => {
        state = (await ctl.state()).mode ?? null;
        bar = await chrome(chromeStatusbarMode);
        return state === expected && bar === expected.toUpperCase();
      },
      { timeoutMs, intervalMs: 50 },
    );
    steps.push({ step, expected, state, statusbar: bar });
    return !!ok;
  };
  /** @param {string} keys */
  const send = (keys) => ctl.sendKeys(keys);
  /**
   * Send `keys` and time how long until `until` is truthy.
   * @param {string} keys
   * @param {() => Promise<unknown>} until
   */
  const timed = async (keys, until, timeoutMs = 2000) => {
    const t0 = performance.now();
    await send(keys);
    const ok = await poll(until, { timeoutMs });
    return ok ? Math.round(performance.now() - t0) : null;
  };
  /** Back to normal mode with no field focused. */
  const toNormal = async () => {
    for (let i = 0; i < 3; i++) {
      const s = await ctl.state();
      if (s.mode === "normal" && !s.pending) return;
      await send("esc");
      await sleep(100);
    }
  };
  /** @param {string} name @param {() => Promise<CheckResult>} body */
  const check = async (name, body) => {
    try {
      await record(await body());
    } catch (e) {
      await record({
        id: name,
        status: "fail",
        reason: `harness error: ${/** @type {Error} */ (e).message}`,
      });
    }
  };
  const waitLoaded = async (timeoutMs = LOAD_TIMEOUT_MS) => {
    /** @type {any} */
    let last = null;
    const done = await poll(
      async () => {
        last = await tab.eval(contentPageInfo, { consentSelectors: CONSENT_SELECTORS });
        if (last.url === "about:blank" || last.readyState !== "complete") return null;
        // A challenge page completes, then navigates: wait until the tab stops loading too.
        return (await chrome(chromeTabBusy)) ? null : last;
      },
      { timeoutMs, intervalMs: 250 },
    );
    return { done, last };
  };

  await chrome(chromeWatchErrors);

  // 1. load ----------------------------------------------------------------------------------
  const t0 = performance.now();
  await ctl.open(site.url);
  const { done, last } = await waitLoaded();
  /** @type {any} */
  let info = done ?? last;
  if (!info || (!done && info.readyState !== "interactive")) {
    await shot("load");
    await record({
      id: "load",
      status: "fail",
      reason: `not loaded in ${LOAD_TIMEOUT_MS / 1000} s (${info?.readyState ?? "no document"})`,
    });
    return finish("page did not load");
  }
  await sleep(SETTLE_MS);
  // Again: a challenge or a client-side redirect may have started another load meanwhile.
  const settled = await waitLoaded(20_000);
  info = settled.done ?? settled.last ?? info;
  result.loadMs = info.loadMs ?? Math.round(performance.now() - t0);
  let block = classifyPage(info);
  /** @type {string | null} */
  let consentClicked = null;
  if (block.kind === "consent") {
    consentClicked = await tab.eval(contentClickReject, { patterns: REJECT_SOURCES });
    if (consentClicked) {
      log(`    consent: clicked "${consentClicked}"`);
      tab.reset();
      await sleep(SETTLE_MS);
      await waitLoaded(20_000);
      await sleep(SETTLE_MS);
      info = await tab.eval(contentPageInfo, { consentSelectors: CONSENT_SELECTORS });
      block = classifyPage(info);
    }
  }
  result.finalUrl = info.url;
  result.title = info.title;
  await shot("load");
  if (block.kind) {
    result.block = { kind: block.kind, reason: block.reason };
    log(`    ${block.kind}: ${block.reason}`);
    await check("errors", errorsCheck);
    return finish(
      block.kind === "bot-check"
        ? `blocked (bot check): ${block.reason}`
        : `consent: ${block.reason}`,
    );
  }
  await record({
    id: "load",
    status: "pass",
    ...(done ? {} : { reason: "the load event did not come within 45 s; the page is interactive" }),
    details: { loadMs: result.loadMs, ...(consentClicked ? { consentClicked } : {}) },
  });
  const active = await tab.eval(contentActive);
  await expectMode("load", active.editable ? "insert" : "normal");
  if (active.editable) {
    await send("esc");
    await expectMode("esc from an autofocused field", "normal");
  }

  // 2. scroll --------------------------------------------------------------------------------
  await check("scroll", async () => {
    const start = await tab.eval(contentScrollSnapshot);
    if (!canScroll(start))
      return { id: "scroll", status: "skip", reason: "nothing on the page scrolls" };
    /** @type {Array<[string, "down" | "up"]>} */
    const moves = [
      ["j", "down"],
      ["k", "up"],
      ["G", "down"],
      ["g g", "up"],
      ["ctrl+d", "down"],
      ["ctrl+u", "up"],
    ];
    /** @type {string[]} */
    const bad = [];
    /** @type {Record<string, string>} */
    const where = {};
    for (const [keys, want] of moves) {
      const before = await tab.eval(contentScrollSnapshot);
      /** @type {ReturnType<typeof scrollMovement>} */
      let move = { moved: "none", where: null, by: 0 };
      const ms = await timed(
        keys,
        async () => {
          move = scrollMovement(before, await tab.eval(contentScrollSnapshot));
          return move.moved !== "none";
        },
        1500,
      );
      if (keys === "j" && ms !== null) result.latency.j = ms;
      where[keys] = move.where ?? "none";
      if (move.moved !== want)
        bad.push(`${keys} ${move.moved === "none" ? "did not scroll" : `went ${move.moved}`}`);
      await sleep(150);
    }
    await expectMode("scroll", "normal");
    const inner = Object.values(where).filter((w) => w !== "main" && w !== "none");
    const details = { where, mainMax: start.main.max, innerScrollers: start.inner.length };
    if (bad.length) return { id: "scroll", status: "fail", reason: bad.join("; "), details };
    return {
      id: "scroll",
      status: "pass",
      ...(inner.length ? { reason: `scrolled ${[...new Set(inner)].join(", ")}` } : {}),
      details,
    };
  });

  // 3. find ----------------------------------------------------------------------------------
  await check("find", async () => {
    await toNormal();
    const word = (site.find ?? (await tab.eval(contentPickWord)) ?? "").toLowerCase();
    if (!word) return { id: "find", status: "skip", reason: "no word on the page to look for" };
    await send("/");
    await expectMode("/", "command");
    await send([...word, "enter"].join(" "));
    /** @type {any} */
    const status = await poll(
      async () => {
        const s = await chrome(chromeFindStatus);
        return s && s.query === word && (s.notFound || (s.total ?? 0) > 0) ? s : null;
      },
      { timeoutMs: 4000, intervalMs: 50 },
    );
    const back = await expectMode("find enter", "normal");
    if (!status) return { id: "find", status: "fail", reason: `no find result for "${word}"` };
    if (status.notFound) return { id: "find", status: "fail", reason: `"${word}" not found` };
    const details = { word, total: status.total, current: status.current };
    if (back) return { id: "find", status: "pass", details };
    const mode = (await ctl.state()).mode;
    const focus = await tab.eval(contentActive).catch(() => null);
    return {
      id: "find",
      status: "fail",
      reason:
        `after Enter the mode is ${mode}, not normal` +
        (focus?.editable ? `: the match took focus into ${focus.desc}, so n would type there` : ""),
      details,
    };
  });

  // 4. yank ----------------------------------------------------------------------------------
  await check("yank", async () => {
    await toNormal();
    const sentinel = `vimma-site-compat-${Date.now()}`;
    await chrome(chromeSetClipboard, { text: sentinel });
    /** @type {string | null} */
    let clip = null;
    const ms = await timed("y y", async () => {
      clip = await chrome(chromeReadClipboard);
      return clip !== sentinel;
    });
    if (ms !== null) result.latency.yy = ms;
    const url = selectedTab(await ctl.state())?.url;
    await expectMode("yy", "normal");
    if (clip === url) return { id: "yank", status: "pass" };
    return {
      id: "yank",
      status: "fail",
      reason:
        clip === sentinel ? "the clipboard did not change" : `copied "${clip}", tab is ${url}`,
    };
  });

  // 6a. prefix in normal mode (recorded with 6b below) ---------------------------------------
  /** @type {string[]} */
  const prefixBad = [];
  /** @type {string[]} */
  const prefixWhere = [];
  /** @param {string} where @param {string} after the mode esc should leave */
  const prefixProbe = async (where, after) => {
    await tab.eval(contentRecorder);
    await send("ctrl+b");
    const pending = (await ctl.state()).pending;
    const rec = await tab.eval(contentRecorder);
    await send("esc");
    const cleared = !(await ctl.state()).pending;
    await expectMode(`ctrl+b esc (${where})`, after);
    prefixWhere.push(where);
    if (pending !== "prefix") prefixBad.push(`${where}: pending was ${pending}`);
    if (rec.seen.includes("ctrl+b")) prefixBad.push(`${where}: the page saw ctrl+b`);
    if (!cleared) prefixBad.push(`${where}: esc did not clear the prefix`);
  };
  let prefixError = null;
  try {
    await toNormal();
    await prefixProbe("normal mode", "normal");
  } catch (e) {
    prefixError = /** @type {Error} */ (e).message;
  }

  // 5. insert (and 6b, prefix in a field) ----------------------------------------------------
  await check("insert", async () => {
    await toNormal();
    const field = await tab.eval(contentFocusField, { selector: site.search ?? null });
    if (!field.found)
      return {
        id: "insert",
        status: "skip",
        reason: site.search ? `no ${site.search}` : "no search field",
      };
    const inInsert = await expectMode("focus the search field", "insert");
    if (!inInsert) {
      return {
        id: "insert",
        status: "fail",
        reason: `focusing ${field.desc} did not give insert mode`,
        details: { field: field.desc, focused: field.focused },
      };
    }
    try {
      await prefixProbe("in a field", "insert");
    } catch (e) {
      prefixError = /** @type {Error} */ (e).message;
    }
    await send("esc");
    const normal = await expectMode("esc in the field", "normal");
    const after = await tab.eval(contentActive);
    if (!normal) return { id: "insert", status: "fail", reason: "esc did not give normal mode" };
    if (after.editable)
      return { id: "insert", status: "fail", reason: `esc left focus in ${after.desc}` };
    return { id: "insert", status: "pass", details: { field: field.desc } };
  });
  await record(
    prefixError
      ? { id: "prefix", status: "fail", reason: `harness error: ${prefixError}` }
      : prefixBad.length
        ? { id: "prefix", status: "fail", reason: prefixBad.join("; ") }
        : { id: "prefix", status: "pass", details: { tried: prefixWhere } },
  );

  // 7. shortcuts (info) ----------------------------------------------------------------------
  await check("shortcuts", async () => {
    if (offline)
      return {
        id: "shortcuts",
        status: "skip",
        reason: "live only: a snapshot has none of the site's scripts",
      };
    await toNormal();
    const startUrl = selectedTab(await ctl.state())?.url;
    /** @type {Array<{ key: string, reaction: string, to?: string }>} */
    const found = [];
    let stopped = null;
    // Synthetic keys at the page (contentPressKey): Vimma's `i` is no clean pass-through (it
    // focuses the first text field), and a key that reached Vimma's normal mode instead would
    // run its command. Sites that ignore untrusted events are under-reported; this is info.
    for (const key of SHORTCUT_KEYS) {
      const before = await poll(
        async () => {
          const a = await tab.eval(contentReaction);
          await sleep(150);
          const b = await tab.eval(contentReaction);
          return JSON.stringify(a) === JSON.stringify(b) ? b : null;
        },
        { timeoutMs: 2000, intervalMs: 50 },
      );
      if (!before) continue; // the page keeps changing by itself: no verdict for this key
      const prevented = await tab.eval(contentPressKey, { key });
      await sleep(350);
      const after = await tab
        .eval(contentReaction)
        .catch(() => ({ ...before, url: "(navigated)" }));
      const reaction = reactionOf(before, after, prevented ? [key] : []);
      if (reaction)
        found.push({ key, reaction, ...(reaction === "focus" ? { to: after.active } : {}) });
      await tab.eval(contentExitFullscreen).catch(() => {});
      await chrome(chromeCloseFindbar);
      await toNormal();
      if (reaction === "navigate") {
        stopped = key;
        break;
      }
    }
    // A shortcut that opened something (a search dialog on `/`, help on `?`) may still be open:
    // the hints check needs the page as it loaded. Back (H) after a navigation, else reload (r).
    const disturbed = found.some((f) => f.reaction !== "handled" && f.reaction !== "scroll");
    if (stopped || disturbed) {
      await toNormal();
      if (stopped) {
        await send("H");
        await poll(async () => selectedTab(await ctl.state())?.url === startUrl, {
          timeoutMs: 15_000,
          intervalMs: 200,
        });
      } else {
        await send("r");
        await sleep(500);
      }
      tab.reset();
      await waitLoaded(20_000);
      await sleep(SETTLE_MS);
      await toNormal();
    }
    await expectMode("after the shortcut probe", "normal");
    const keys = found.map((f) => f.key);
    return {
      id: "shortcuts",
      status: "info",
      reason: keys.length
        ? `site handles: ${found.map((f) => `${f.key} (${f.reaction})`).join(", ")}${stopped ? `; stopped at ${stopped}` : ""}`
        : "the site handles none of Vimma's single keys",
      details: { keys, found },
    };
  });

  // 8. hints ---------------------------------------------------------------------------------
  await check("hints", async () => {
    await toNormal();
    await send("g g");
    await sleep(300);
    const clickables = await tab.eval(contentClickables);
    /** @type {Array<{ label: string, x: number, y: number }>} */
    let labels = [];
    const ms = await timed(
      "f",
      async () => {
        labels = await chrome(chromeHints);
        return labels.length > 0;
      },
      3000,
    );
    if (ms !== null) result.latency.f = ms;
    // Subframes answer later than the top frame: count once the labels stop coming.
    if (labels.length) {
      labels =
        (await poll(
          async () => {
            const a = await chrome(chromeHints);
            await sleep(150);
            const b = await chrome(chromeHints);
            return a.length === b.length ? b : null;
          },
          { timeoutMs: 2000, intervalMs: 0 },
        )) ?? labels;
    }
    if (!labels.length) {
      await toNormal();
      return clickables
        ? {
            id: "hints",
            status: "fail",
            reason: `no labels, though ${clickables} links or buttons are visible`,
          }
        : { id: "hints", status: "skip", reason: "nothing to hint in the viewport" };
    }
    await expectMode("f", "hint");
    await shot("hints");
    const links = await tab.eval(contentLinksAt, { points: labels });
    const choice = chooseHintLink(links);
    const details = { labels: labels.length, clickables, followed: choice?.href ?? null };
    if (!choice) {
      await send("esc");
      await expectMode("esc from hints", "normal");
      return {
        id: "hints",
        status: "skip",
        reason: `${labels.length} labels, none on a same-tab link to follow`,
        details,
      };
    }
    const before = selectedTab(await ctl.state())?.url;
    const followMs = await timed(
      [...choice.label].join(" "),
      async () => selectedTab(await ctl.state())?.url !== before,
      10_000,
    );
    if (followMs === null) {
      await toNormal();
      return {
        id: "hints",
        status: "fail",
        reason: `typing "${choice.label}" did not navigate`,
        details,
      };
    }
    result.latency.follow = followMs;
    tab.reset();
    await waitLoaded(20_000);
    const landed = await tab.eval(contentActive).catch(() => ({ editable: false }));
    await expectMode("follow a hint", landed.editable ? "insert" : "normal", 3000);
    return { id: "hints", status: "pass", details };
  });

  await check("errors", errorsCheck);
  return finish("");

  /** @returns {Promise<CheckResult>} */
  async function errorsCheck() {
    const errors = await chrome(chromeTakeErrors);
    if (!errors.length) return { id: "errors", status: "pass" };
    return {
      id: "errors",
      status: "fail",
      reason:
        errors.slice(0, 3).join(" | ") + (errors.length > 3 ? ` (+${errors.length - 3})` : ""),
      details: { errors },
    };
  }

  /** @param {string} reason why checks that never ran were skipped */
  function finish(reason) {
    if (!checks.some((c) => c.id === "statusbar") && steps.length)
      checks.push(statusbarCheck(steps));
    result.checks = completeChecks(checks, reason || "not reached");
    result.status = siteStatus(result);
    return result;
  }
}

/**
 * Load `url` and take its snapshot (snapshot.mjs, contentSnapshot) once it has loaded and
 * settled, as the checks would see it.
 * @param {string} url
 * @param {Context} ctx
 * @returns {Promise<{ html: string, skippedSheets: number, cssBytes: number, title: string }>}
 */
export async function recordSnapshot(url, ctx) {
  const tab = new Tab(ctx);
  /** @param {Function} fn */
  const chrome = async (fn) => JSON.parse(await ctx.rdp.evaluate(ctx.parent, probe(fn)));
  const loaded = async (/** @type {number} */ timeoutMs) =>
    poll(
      async () => {
        const info = await tab.eval(contentPageInfo, { consentSelectors: CONSENT_SELECTORS });
        if (info.url === "about:blank" || info.readyState !== "complete") return null;
        return (await chrome(chromeTabBusy)) ? null : info;
      },
      { timeoutMs, intervalMs: 250 },
    );
  await ctx.ctl.open(url);
  if (!(await loaded(LOAD_TIMEOUT_MS))) throw new Error(`${url} did not load`);
  await sleep(SETTLE_MS);
  const info = await loaded(20_000);
  if (!info) throw new Error(`${url} did not settle`);
  const block = classifyPage(info);
  if (block.kind) throw new Error(`${url}: ${block.kind} (${block.reason}), not recorded`);
  const snap = await tab.eval(
    contentSnapshot,
    { csp: SNAPSHOT_CSP, follow: FOLLOW_TARGET },
    { timeoutMs: 60_000 },
  );
  return { ...snap, title: info.title };
}
