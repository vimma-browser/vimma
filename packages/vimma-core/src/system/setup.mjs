/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The first-run setup's pure parts (docs/specs/first-run-setup.md): the curated add-ons, the
 * filter on AMO answers, the step state machine and the plan the summary applies; and setup
 * v2's chapter flow (docs/specs/setup-v2.md), behind `vimma.feature.setupV2` until it replaces
 * the summary.
 */

import { CHAPTERS } from "./setup-steps.mjs";

/** @import { SetupChapter } from "./setup-steps.mjs" */

/**
 * The curated content blockers, pinned by GUID and slug (decision 13): all three are AMO
 * "Recommended". An AMO answer for one of these slugs with another GUID is dropped.
 */
export const CURATED = Object.freeze([
  {
    slug: "ublock-origin",
    guid: "uBlock0@raymondhill.net",
    name: "uBlock Origin",
    author: "Raymond Hill",
    summary: "An efficient wide-spectrum content blocker, easy on CPU and memory.",
  },
  {
    slug: "adguard-adblocker",
    guid: "adguardadblocker@adguard.com",
    name: "AdGuard AdBlocker",
    author: "AdGuard",
    summary: "Blocks ads, pop-ups and trackers on every site.",
  },
  {
    slug: "privacy-badger17",
    guid: "jid1-MnnxcxisBPnSXQ@jetpack",
    name: "Privacy Badger",
    author: "EFF Technologists",
    summary: "Learns to block invisible trackers as you browse.",
  },
]);

/**
 * The curated list before AMO answers, or offline (behaviour 7): shown, but with no file to
 * install, so it cannot be marked.
 * @param {Set<string>} [installed]
 * @returns {AddonEntry[]}
 */
export function curatedOffline(installed = new Set()) {
  return CURATED.map((c) => ({
    ...c,
    users: 0,
    url: "",
    hash: "",
    installed: installed.has(c.guid),
  }));
}

/** The AMO request timeout (behaviour 7). */
export const AMO_TIMEOUT_MS = 10_000;

/** AMO's public search: no key, no account (Research). */
export const AMO_API = "https://addons.mozilla.org/api/v5/addons/";

/** @param {string} terms @param {string} [base] */
export function amoSearchUrl(terms, base = AMO_API) {
  const q = new URLSearchParams({ q: terms, app: "firefox", type: "extension", sort: "users" });
  return `${base}search/?${q}`;
}

/** The curated entries in one request: AMO's search takes a comma-separated `guid` list. */
export function amoCuratedUrl(base = AMO_API) {
  const q = new URLSearchParams({ guid: CURATED.map((c) => c.guid).join(","), app: "firefox" });
  return `${base}search/?${q}`;
}

/**
 * @typedef {object} AddonEntry
 * @property {string} guid
 * @property {string} slug
 * @property {string} name
 * @property {string} author
 * @property {string} summary
 * @property {number} users      average daily users
 * @property {string} url        the signed .xpi on addons.mozilla.org
 * @property {string} hash       "sha256:…"
 * @property {boolean} installed
 */

/** A localised AMO string: the en-US text, else the first one. */
function text(/** @type {unknown} */ v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = /** @type {Record<string, unknown>} */ (v);
    const s = o["en-US"] ?? Object.values(o)[0];
    return typeof s === "string" ? s : "";
  }
  return "";
}

/**
 * A JSON object (not null, not an array): AMO's answer is read one level at a time.
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isRecord(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Only an https file on addons.mozilla.org itself (decision 4). */
function amoFile(/** @type {unknown} */ url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "addons.mozilla.org" && u.port === "";
  } catch {
    return false;
  }
}

/**
 * AMO results the setup may offer (decision 4, Security "Only AMO, only signed"): an extension,
 * its file https on addons.mozilla.org with a sha256 hash. With `curated`, only the pinned
 * slug and GUID pairs pass.
 * @param {unknown[]} results  `results` of an AMO search answer
 * @param {{ curated?: boolean, installed?: Set<string> }} [options]
 * @returns {AddonEntry[]}
 */
export function amoEntries(results, { curated = false, installed = new Set() } = {}) {
  /** @type {AddonEntry[]} */
  const out = [];
  for (const r of Array.isArray(results) ? results : []) {
    if (!isRecord(r) || r.type !== "extension") continue;
    const { guid, slug } = r;
    if (typeof guid !== "string" || typeof slug !== "string") continue;
    const version = r.current_version;
    const file = isRecord(version) && isRecord(version.file) ? version.file : undefined;
    const url = file?.url;
    const hash = file?.hash;
    if (typeof url !== "string" || !amoFile(url)) continue;
    if (typeof hash !== "string" || !/^sha256:[0-9a-f]+$/i.test(hash)) continue;
    if (curated && !CURATED.some((c) => c.slug === slug && c.guid === guid)) continue;
    const first = Array.isArray(r.authors) ? r.authors[0] : undefined;
    const users = r.average_daily_users;
    out.push({
      guid,
      slug,
      name: text(r.name) || slug,
      author: isRecord(first) ? text(first.name) : "",
      summary: text(r.summary),
      users: typeof users === "number" && Number.isFinite(users) ? users : 0,
      url,
      hash,
      installed: installed.has(guid),
    });
  }
  if (curated) out.sort((a, b) => curatedIndex(a.guid) - curatedIndex(b.guid));
  return out;
}

const curatedIndex = (/** @type {string} */ guid) => CURATED.findIndex((c) => c.guid === guid);

/**
 * @typedef {object} SetupState
 * @property {"welcome" | "addons" | "engine" | "summary" | "closed"} step
 * @property {number} cursor
 * @property {AddonEntry[]} addons   the list step 1 shows
 * @property {Map<string, AddonEntry>} marked  by GUID, kept across searches
 * @property {string[]} engines
 * @property {string | null} engine  the current default, then the chosen one
 */

/**
 * @param {{ addons: AddonEntry[], engines: string[], engine: string | null }} init
 * @returns {SetupState}
 */
export function initialSetup({ addons, engines, engine }) {
  return { step: "welcome", cursor: 0, addons, marked: new Map(), engines, engine };
}

/** Step 1's list replaced (a search answered, or the curated list back). */
export function withAddons(/** @type {SetupState} */ s, /** @type {AddonEntry[]} */ addons) {
  return { ...s, addons, cursor: 0 };
}

/**
 * @typedef {{ type: "close" } | { type: "search" } | { type: "apply", plan: SetupPlan }
 *   | { type: "done" }} SetupEffect
 */

/**
 * One key on the page, outside the search field. Nothing is applied here: the summary's
 * `enter` returns the plan for the host to apply (decision 2).
 * @param {SetupState} s
 * @param {string} key  "enter", "esc", "q", "j", "k", "space", "/" (Vimma's key notation)
 * @returns {{ state: SetupState, effect: SetupEffect | null }}
 */
export function setupKey(s, key) {
  const stay = { state: s, effect: null };
  const close = {
    state: { ...s, step: /** @type {const} */ ("closed") },
    effect: { type: /** @type {const} */ ("close") },
  };
  const move = (/** @type {number} */ n, /** @type {number} */ d) =>
    n === 0
      ? stay
      : { state: { ...s, cursor: Math.max(0, Math.min(n - 1, s.cursor + d)) }, effect: null };
  switch (s.step) {
    case "welcome":
      if (key === "enter") return { state: { ...s, step: "addons", cursor: 0 }, effect: null };
      if (key === "esc" || key === "q") return close;
      return stay;
    case "addons": {
      if (key === "esc" || key === "q") return close;
      if (key === "j" || key === "down") return move(s.addons.length, 1);
      if (key === "k" || key === "up") return move(s.addons.length, -1);
      if (key === "/") return { state: s, effect: { type: "search" } };
      if (key === "space") {
        const a = s.addons[s.cursor];
        if (!a || a.installed || !a.url) return stay;
        const marked = new Map(s.marked);
        if (marked.has(a.guid)) marked.delete(a.guid);
        else marked.set(a.guid, a);
        return { state: { ...s, marked }, effect: null };
      }
      if (key === "enter") {
        const at = s.engine ? s.engines.indexOf(s.engine) : -1;
        return { state: { ...s, step: "engine", cursor: Math.max(0, at) }, effect: null };
      }
      return stay;
    }
    case "engine":
      if (key === "esc" || key === "q") return close;
      if (key === "j" || key === "down") return move(s.engines.length, 1);
      if (key === "k" || key === "up") return move(s.engines.length, -1);
      if (key === "enter") {
        const engine = s.engines[s.cursor] ?? s.engine;
        return { state: { ...s, step: "summary", engine }, effect: null };
      }
      return stay;
    case "summary": {
      if (key === "esc") {
        const at = s.engine ? s.engines.indexOf(s.engine) : 0;
        return { state: { ...s, step: "engine", cursor: Math.max(0, at) }, effect: null };
      }
      const plan = planSetup(s);
      if (key === "enter" && plan) return { state: s, effect: { type: "apply", plan } };
      return stay;
    }
    default:
      return stay;
  }
}

/**
 * @typedef {object} SetupPlan
 * @property {AddonEntry[]} addons  to install, one after another
 * @property {string | null} engine  `[search] default` to write
 */

/**
 * What the summary would apply: null before the summary and after a skip (behaviour 2, 6).
 * @param {SetupState} s
 * @returns {SetupPlan | null}
 */
export function planSetup(s) {
  if (s.step !== "summary") return null;
  return { addons: [...s.marked.values()].filter((a) => !a.installed), engine: s.engine };
}

/** "1.2M users" style, for the list. */
export function formatUsers(/** @type {number} */ n) {
  // Round first, then pick the unit, so 999_999 reads as 1.0M rather than 1000k (#1190).
  if (n >= 1e6 || Math.round(n / 1e3) >= 1000) return `${scaledUsers(n / 1e6)}M users`;
  if (n >= 1e3) return `${scaledUsers(n / 1e3)}k users`;
  return `${n} users`;
}

/** One decimal below 10 of the unit, whole units from there: 9.9k, then 10k rather than 10.0k. */
function scaledUsers(/** @type {number} */ x) {
  const tenths = x.toFixed(1);
  return Number(tenths) < 10 ? tenths : x.toFixed(0);
}

/**
 * The steps of setup v2 the page draws so far: the delivery slices add theirs here, with a
 * renderer in the page (docs/specs/setup-v2.md, Delivery). The host saves only these, so a step
 * whose rules have not landed (the agents step's consent) cannot be written through the page.
 */
export const BUILT_STEPS = Object.freeze([
  "content_blocker",
  "search_engine",
  "colours",
  // The window (chapter 3): the tab line step (#1299) goes after the address bar; the page draws
  // its window from windowSketch (setup-steps.mjs) already.
  "address_bar",
]);

/**
 * The chapters with only `built` steps, chapters left without one dropped; each keeps its
 * digit, so a later chapter's key never changes.
 * @param {readonly string[]} [built]
 * @returns {SetupChapter[]}
 */
export function flowChapters(built = BUILT_STEPS) {
  return CHAPTERS.map((c) => ({ ...c, steps: c.steps.filter((s) => built.includes(s.id)) })).filter(
    (c) => c.steps.length,
  );
}

/**
 * @typedef {object} FlowSaved  what one step of this run wrote, for the footer and stop screen
 * @property {string} chapter
 * @property {string} step
 * @property {string[]} lines
 */

/**
 * @typedef {object} FlowState
 * @property {"welcome" | "step" | "stop" | "closed"} screen
 * @property {readonly SetupChapter[]} chapters
 * @property {number} chapter  index into `chapters`
 * @property {number} step     index into the chapter's steps
 * @property {number} cursor
 * @property {boolean} searching  the content blocker's search field has the keys
 * @property {Map<string, AddonEntry>} marked  by GUID, kept across searches
 * @property {FlowSaved[]} saved
 * @property {boolean} blocked  setting steps can only skip (a parse error, a private window)
 * @property {boolean} done     the stop screen is the last one
 */

/**
 * What the page knows of the open step: the rows of its list, the row of the value in force of
 * any step (behaviour 9), and the content blocker's add-ons.
 * @typedef {object} FlowContext
 * @property {number} count
 * @property {(chapter: number, step: number) => number} selected
 * @property {readonly AddonEntry[]} addons
 */

/**
 * @typedef {{ type: "close" } | { type: "search" } | { type: "blur" } | { type: "run-search" }
 *   | { type: "save", step: string, index: number }
 *   | { type: "action", step: string, index: number }
 *   | { type: "install", addons: AddonEntry[] }
 *   | { type: "chapter-done", chapter: string }} FlowEffect
 */

/**
 * @param {{ chapters: readonly SetupChapter[], blocked?: boolean }} init
 * @returns {FlowState}
 */
export function initialFlow({ chapters, blocked = false }) {
  return {
    screen: "welcome",
    chapters,
    chapter: 0,
    step: 0,
    cursor: 0,
    searching: false,
    marked: new Map(),
    saved: [],
    blocked,
    done: false,
  };
}

/** @param {FlowState} s @returns {import("./setup-steps.mjs").SetupStep | undefined} */
export const flowStep = (s) =>
  s.screen === "step" ? s.chapters[s.chapter]?.steps[s.step] : undefined;

/**
 * @param {FlowState} s @param {number} chapter @param {number} step @param {FlowContext} ctx
 * @returns {{ state: FlowState, effect: FlowEffect | null }}
 */
function openStep(s, chapter, step, ctx) {
  return {
    state: {
      ...s,
      screen: "step",
      chapter,
      step,
      cursor: ctx.selected(chapter, step),
      searching: false,
      done: false,
    },
    effect: null,
  };
}

/**
 * The stop screen of chapter `chapter` (behaviour 10); reaching it finishes the chapter.
 * @param {FlowState} s @param {number} chapter
 * @returns {{ state: FlowState, effect: FlowEffect | null }}
 */
function openStop(s, chapter) {
  const id = s.chapters[chapter]?.id ?? "";
  return {
    state: {
      ...s,
      screen: "stop",
      chapter,
      step: 0,
      cursor: 0,
      searching: false,
      done: chapter === s.chapters.length - 1,
    },
    effect: { type: "chapter-done", chapter: id },
  };
}

/**
 * The step after the open one, or its chapter's stop screen; a step that wrote `lines` is
 * listed as saved, replacing what an earlier `enter` on it saved (behaviour 6).
 * @param {FlowState} s @param {FlowContext} ctx
 * @param {readonly string[]} [lines]  what the step wrote; none for a skip or "writes nothing"
 * @returns {{ state: FlowState, effect: FlowEffect | null }}
 */
export function flowAdvance(s, ctx, lines = []) {
  const step = flowStep(s);
  if (!step) return { state: s, effect: null };
  const chapter = s.chapters[s.chapter];
  const saved = s.saved.filter((x) => x.step !== step.id);
  if (lines.length) saved.push({ chapter: chapter?.id ?? "", step: step.id, lines: [...lines] });
  const next = { ...s, saved, marked: step.id === "content_blocker" ? new Map() : s.marked };
  if (chapter && s.step + 1 < chapter.steps.length)
    return openStep(next, s.chapter, s.step + 1, ctx);
  return openStop(next, s.chapter);
}

/**
 * One key on the page (behaviours 3-11), in Vimma's key notation; in the search field only
 * `enter` and `esc` reach here. `enter` on a step returns what to do, and the page calls
 * flowAdvance once it is done; a failed save keeps the step open.
 * @param {FlowState} s @param {string} key @param {FlowContext} ctx
 * @returns {{ state: FlowState, effect: FlowEffect | null }}
 */
export function flowKey(s, key, ctx) {
  const stay = { state: s, effect: null };
  /** @type {{ state: FlowState, effect: FlowEffect }} */
  const close = { state: { ...s, screen: "closed", searching: false }, effect: { type: "close" } };
  if (s.screen === "closed") return stay;
  if (s.searching) {
    if (key === "esc") return { state: { ...s, searching: false }, effect: { type: "blur" } };
    if (key === "enter")
      return { state: { ...s, searching: false }, effect: { type: "run-search" } };
    return stay;
  }
  if (key === "q" || key === "esc") return close;
  const digit = s.chapters.findIndex((c) => String(c.digit) === key);
  if (digit >= 0) return openStep(s, digit, 0, ctx);
  if (s.screen === "welcome") return key === "enter" ? openStep(s, 0, 0, ctx) : stay;
  if (s.screen === "stop") {
    if (key === "h") {
      return openStep(s, s.chapter, (s.chapters[s.chapter]?.steps.length ?? 1) - 1, ctx);
    }
    if (key !== "enter") return stay;
    return s.done ? close : openStep(s, s.chapter + 1, 0, ctx);
  }
  const step = flowStep(s);
  if (!step) return stay;
  const move = (/** @type {number} */ d) =>
    ctx.count === 0
      ? stay
      : {
          state: { ...s, cursor: Math.max(0, Math.min(ctx.count - 1, s.cursor + d)) },
          effect: null,
        };
  switch (key) {
    case "j":
    case "down":
      return move(1);
    case "k":
    case "up":
      return move(-1);
    case "s":
      return flowAdvance(s, ctx);
    case "h":
      if (s.step > 0) return openStep(s, s.chapter, s.step - 1, ctx);
      if (s.chapter > 0) return openStop(s, s.chapter - 1);
      return { state: { ...s, screen: "welcome", searching: false }, effect: null };
  }
  if (step.id === "content_blocker") {
    if (key === "/") return { state: { ...s, searching: true }, effect: { type: "search" } };
    if (key === "space") {
      const a = ctx.addons[s.cursor];
      if (!a || a.installed || !a.url) return stay;
      const marked = new Map(s.marked);
      if (marked.has(a.guid)) marked.delete(a.guid);
      else marked.set(a.guid, a);
      return { state: { ...s, marked }, effect: null };
    }
    if (key === "enter") {
      const addons = [...s.marked.values()].filter((a) => !a.installed);
      return addons.length
        ? { state: s, effect: { type: "install", addons } }
        : flowAdvance(s, ctx);
    }
    return stay;
  }
  if (key !== "enter") return stay;
  if (step.kind === "action") {
    return { state: s, effect: { type: "action", step: step.id, index: s.cursor } };
  }
  if (s.blocked) return stay;
  return { state: s, effect: { type: "save", step: step.id, index: s.cursor } };
}
