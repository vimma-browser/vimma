/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Which tabs go to sleep (docs/specs/tab-sleep.md, decision 3): the host gathers plain facts
// per tab and calls Firefox's discard; the rules live here, so that the check and `:sleep`
// agree on what is safe.

import { matchSiteRule } from "../keys/editable.mjs";

/** How often the host checks (decision 2): a tab sleeps up to this long after its limit. */
export const SLEEP_CHECK_MS = 5 * 60_000;

/** `[tabs] sleep_after` in minutes (decisions 11 and 22): 0 is off, else MIN to MAX. */
export const SLEEP_AFTER = Object.freeze({ default: 120, min: 5, max: 10080 });

/**
 * One tab's facts, gathered by the host without touching its page.
 * @typedef {object} SleepTab
 * @property {string} id
 * @property {number} lastSeen  ms: the later of its last selection and the last check that
 *   found it on screen (decision 4)
 * @property {boolean} onScreen  selected, or a pane of the split its window shows
 * @property {boolean} pinned
 * @property {boolean} sound
 * @property {boolean} pip       shown in Picture-in-Picture
 * @property {boolean} sharing   camera, microphone, screen, or a WebRTC connection
 * @property {boolean} private
 * @property {boolean} agent     in the agent workspace
 * @property {string} url
 * @property {boolean} loading
 * @property {boolean} asleep    no loaded page already
 */

/**
 * Why a tab stays awake, the first rule of Behaviour 2 that holds; "recent" is the time rule.
 * @typedef {"onScreen" | "pinned" | "sound" | "pip" | "sharing" | "private" | "agent" | "page"
 *   | "site" | "loading" | "recent"} SleepReason
 */

/**
 * How the plan was asked for: "time" by the check, "hand" by `:sleep` (no time rule), "named"
 * by `:sleep N` (no time, pin or site rule; decision 14).
 * @typedef {"time" | "hand" | "named"} SleepMode
 */

/** Only web pages sleep (decision 9). */
const WEB_SCHEMES = new Set(["http:", "https:", "file:"]);

/** @param {string} url */
function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * @param {SleepTab} t
 * @param {{ mode: SleepMode, agentConnected: boolean,
 *   sites: readonly { match: string, sleep: boolean }[] }} ctx
 * @returns {SleepReason | null}
 */
function protection(t, { mode, agentConnected, sites }) {
  if (t.onScreen) return "onScreen";
  if (t.pinned && mode !== "named") return "pinned";
  if (t.sound) return "sound";
  if (t.pip) return "pip";
  if (t.sharing) return "sharing";
  if (t.private) return "private";
  if (t.agent && agentConnected) return "agent";
  const url = parse(t.url);
  if (!url || !WEB_SCHEMES.has(url.protocol)) return "page";
  if (mode !== "named" && url.hostname && matchSiteRule(url.hostname, sites)?.sleep === false) {
    return "site";
  }
  if (t.loading) return "loading";
  return null;
}

/**
 * The tabs to put to sleep, and for each tab kept awake the first rule that keeps it. Tabs
 * already asleep are in neither list. With `mode` "time" and `sleepAfterMs` 0, nothing is
 * planned (Behaviour 3).
 * @param {{ now: number, sleepAfterMs: number, tabs: readonly SleepTab[],
 *   sites: readonly { match: string, sleep: boolean }[], agentConnected: boolean,
 *   mode?: SleepMode }} input
 * @returns {{ sleep: string[], keep: { id: string, reason: SleepReason }[] }}
 */
export function planSleep({ now, sleepAfterMs, tabs, sites, agentConnected, mode = "time" }) {
  /** @type {string[]} */
  const sleep = [];
  /** @type {{ id: string, reason: SleepReason }[]} */
  const keep = [];
  if (mode === "time" && sleepAfterMs <= 0) return { sleep, keep };
  for (const t of tabs) {
    if (t.asleep) continue;
    let reason = protection(t, { mode, agentConnected, sites });
    if (!reason && mode === "time" && now - t.lastSeen <= sleepAfterMs) reason = "recent";
    if (reason) keep.push({ id: t.id, reason });
    else sleep.push(t.id);
  }
  return { sleep, keep };
}

/**
 * Why a tab stayed awake by hand: a rule of `planSleep`, or "unload", Firefox's own refusal
 * after the plan (a page that would ask before leaving, or a dialog over it; decision 10).
 * @typedef {SleepReason | "unload"} AwakeReason
 */

/** What `:sleep` says in a private window (Behaviour 13). */
export const PRIVATE_SLEEP_TEXT = "Private tabs do not sleep";

/**
 * Each reason as `:sleep`'s report names it, in Behaviour 2's order, which breaks a tie: with
 * the start page and the tab on screen, "on screen" is the one the user is looking at.
 * @type {Readonly<Record<AwakeReason, string>>}
 */
const REASON_TEXT = Object.freeze({
  onScreen: "on screen",
  pinned: "pinned",
  sound: "playing sound",
  pip: "in Picture-in-Picture",
  sharing: "sharing a camera, microphone or screen",
  private: "private",
  agent: "an agent is connected",
  page: "not a web page",
  site: "its site has sleep = false",
  loading: "loading",
  recent: "seen recently",
  unload: "it would ask before leaving",
});

/** The reasons that read as a sentence alone; the others follow "it is". */
const OWN_SENTENCE = new Set(["agent", "site", "unload"]);

/**
 * `:sleep`'s report (Behaviour 9): `2 tabs asleep; 3 stay awake: on screen`, the most common
 * reason named, on a tie the one Behaviour 2 lists first.
 * @param {{ slept: number, keep: readonly AwakeReason[] }} report
 */
export function sleepReport({ slept, keep }) {
  const head = `${slept} ${slept === 1 ? "tab" : "tabs"} asleep`;
  if (!keep.length) return head;
  /** @type {Map<AwakeReason, number>} */
  const counts = new Map();
  for (const r of keep) counts.set(r, (counts.get(r) ?? 0) + 1);
  let top = /** @type {AwakeReason} */ (keep[0]);
  let most = 0;
  for (const r of /** @type {AwakeReason[]} */ (Object.keys(REASON_TEXT))) {
    const n = counts.get(r) ?? 0;
    if (n > most) [top, most] = [r, n];
  }
  const stay = keep.length === 1 ? "stays" : "stay";
  return `${head}; ${keep.length} ${stay} awake: ${REASON_TEXT[top]}`;
}

/**
 * What happened to one tab put to sleep by hand: null once asleep, "asleep" when it had no
 * loaded page already (a restart's lazy tab, or the timed check's during the flush), "closed"
 * when it closed meanwhile, else why it stayed awake.
 * @typedef {AwakeReason | "asleep" | "closed" | null} SleepOutcome
 */

/**
 * What `:sleep N`, or `z` in the side panel, says (Behaviour 11): one tab by its number, or
 * several as `:sleep` reports them, leaving out the tabs that were asleep already or closed.
 * @param {readonly { number: number, reason: SleepOutcome }[]} named
 */
export function namedSleepText(named) {
  const [only] = named;
  if (named.length === 1 && only) {
    const n = only.number;
    if (only.reason === null) return `Tab ${n} asleep`;
    if (only.reason === "asleep") return `Tab ${n} is asleep already`;
    if (only.reason === "closed") return `Tab ${n} closed`;
    if (only.reason === "onScreen") return `Tab ${n} is on screen`;
    const why = REASON_TEXT[only.reason];
    return `Tab ${n} stays awake: ${OWN_SENTENCE.has(only.reason) ? why : `it is ${why}`}`;
  }
  return sleepReport(outcomeReport(named.map((t) => t.reason)));
}

/**
 * The counts `sleepReport` takes from tabs' outcomes: the tabs asleep already and the tabs
 * closed meanwhile are in neither.
 * @param {readonly SleepOutcome[]} outcomes
 * @returns {{ slept: number, keep: AwakeReason[] }}
 */
export function outcomeReport(outcomes) {
  /** @type {AwakeReason[]} */
  const keep = [];
  let slept = 0;
  for (const o of outcomes) {
    if (o === null) slept++;
    else if (o !== "asleep" && o !== "closed") keep.push(o);
  }
  return { slept, keep };
}
