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
